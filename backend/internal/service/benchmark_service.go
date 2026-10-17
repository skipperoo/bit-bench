package service

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"bitbench/internal/compressor"
	"bitbench/internal/config"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/seqfile"
)

var nonAlphaNum = regexp.MustCompile(`[^a-zA-Z0-9]+`)

type BenchmarkService struct {
	benchRepo   *repository.BenchmarkRepository
	resultRepo  *repository.BenchmarkResultRepository
	pkgRepo     *repository.CompressorPackageRepository
	taskRepo    *repository.BenchmarkTaskRepository
	cfg         *config.Config
	runningFunc func() int
}

func NewBenchmarkService(br *repository.BenchmarkRepository, rr *repository.BenchmarkResultRepository, pr *repository.CompressorPackageRepository, tr *repository.BenchmarkTaskRepository, cfg *config.Config) *BenchmarkService {
	return &BenchmarkService{benchRepo: br, resultRepo: rr, pkgRepo: pr, taskRepo: tr, cfg: cfg}
}

// UploadedFile is one file of a (possibly multi-file) benchmark upload.
type UploadedFile struct {
	Reader   io.ReadSeeker
	Filename string
}

func (s *BenchmarkService) SetRunningFunc(fn func() int) {
	s.runningFunc = fn
}

// fileChecksum computes MD5 hex of reader content.
func fileChecksum(r io.Reader) (string, error) {
	h := md5.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// escapeFilename applies the spec's escaping rule:
// replace runs of non-alphanumerics with "_", strip leading/trailing "_".
func escapeFilename(name string) string {
	escaped := nonAlphaNum.ReplaceAllString(name, "_")
	escaped = strings.Trim(escaped, "_")
	return escaped
}

// StoredFilename returns the on-disk filename per §4.5 "Filename-escaping rule".
func StoredFilename(originalName, md5Hex string) string {
	ext := filepath.Ext(originalName)
	base := strings.TrimSuffix(originalName, ext)
	escaped := escapeFilename(base)
	return fmt.Sprintf("%s-%s%s", escaped, md5Hex, ext)
}

// validateFileExt checks if the extension is allowed.
var allowedExts = map[string]bool{".bin": true, ".csv": true, ".zip": true, ".tar": true}

func ValidateFileExt(ext string) bool {
	return allowedExts[strings.ToLower(ext)]
}

func (s *BenchmarkService) CreateBenchmark(ctx context.Context, actor *model.User, name string, files []UploadedFile, compressorsJSON []byte) (*model.Benchmark, error) {
	if actor == nil {
		return nil, fmt.Errorf("unauthorized")
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("at least one file is required")
	}

	// Validate extensions and per-file sizes.
	totalSize := int64(0)
	for _, file := range files {
		ext := strings.ToLower(filepath.Ext(file.Filename))
		if !ValidateFileExt(ext) {
			return nil, fmt.Errorf("unsupported file extension: %s", ext)
		}
		size, err := file.Reader.Seek(0, io.SeekEnd)
		if err != nil {
			return nil, fmt.Errorf("read file size: %w", err)
		}
		if _, err := file.Reader.Seek(0, io.SeekStart); err != nil {
			return nil, fmt.Errorf("rewind file: %w", err)
		}
		if s.cfg.MaxFileSizeMB > 0 && size > s.cfg.MaxFileSizeMB*1024*1024 {
			return nil, fmt.Errorf("file %s exceeds max size of %d MB", file.Filename, s.cfg.MaxFileSizeMB)
		}
		totalSize += size
	}

	// Resolve, canonicalize and validate every configured instance.
	resolved, err := s.resolveInstances(ctx, actor, compressorsJSON)
	if err != nil {
		return nil, err
	}
	instances := make([]compressor.Instance, 0, len(resolved))
	builtinCount := 0
	customCount := 0
	for _, r := range resolved {
		instances = append(instances, r.Instance)
		if r.Package == nil {
			builtinCount++
		} else {
			customCount++
		}
	}
	if builtinCount == 0 && customCount == 0 {
		return nil, fmt.Errorf("no compressors selected")
	}

	benchmarkID := uuid.New()
	workRoot := filepath.Join(s.cfg.DataDir, benchmarkID.String())
	if err := os.MkdirAll(workRoot, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	srcDir := filepath.Join(workRoot, "sources")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		os.RemoveAll(workRoot)
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	cleanup := func() { os.RemoveAll(workRoot) }

	// Save the sources while computing the combined checksum, then normalize
	// each one to .bin (one .bin per CSV column or archive member).
	hasher := md5.New()
	var binPaths []string
	for i, file := range files {
		ext := strings.ToLower(filepath.Ext(file.Filename))
		base := escapeFilename(strings.TrimSuffix(filepath.Base(file.Filename), filepath.Ext(file.Filename)))
		if base == "" {
			base = "input"
		}
		srcPath := filepath.Join(srcDir, fmt.Sprintf("%02d-%s%s", i, base, ext))

		dst, err := os.Create(srcPath)
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("store file: %w", err)
		}
		if _, err := io.Copy(io.MultiWriter(dst, hasher), file.Reader); err != nil {
			dst.Close()
			cleanup()
			return nil, fmt.Errorf("store file: %w", err)
		}
		dst.Close()

		inputDir := filepath.Join(workRoot, "inputs", fmt.Sprintf("%02d", i))
		bins, err := seqfile.NormalizeFile(srcPath, inputDir, ext)
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("normalize %s: %w", file.Filename, err)
		}
		binPaths = append(binPaths, bins...)
	}
	checksum := hex.EncodeToString(hasher.Sum(nil))

	// One built-in task per .bin (all built-in instances batched) plus one task
	// per (custom package instance x .bin), each costing its worker count.
	var tasks []*model.BenchmarkTask
	seq := 0
	for _, binPath := range binPaths {
		rel, err := filepath.Rel(s.cfg.DataDir, binPath)
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("resolve task input: %w", err)
		}
		if builtinCount > 0 {
			seq++
			tasks = append(tasks, &model.BenchmarkTask{
				BenchmarkID: benchmarkID,
				Seq:         seq,
				Kind:        model.TaskKindBuiltin,
				InputPath:   rel,
				Workers:     1,
			})
		}
		for _, r := range resolved {
			if r.Package == nil {
				continue
			}
			seq++
			pkgName := r.Instance.Name
			label := r.Instance.Label
			tasks = append(tasks, &model.BenchmarkTask{
				BenchmarkID:   benchmarkID,
				Seq:           seq,
				Kind:          model.TaskKindCustom,
				Compressor:    &pkgName,
				InstanceLabel: &label,
				InputPath:     rel,
				Workers:       r.Package.Workers,
			})
		}
	}
	if len(tasks) == 0 {
		cleanup()
		return nil, fmt.Errorf("no benchmark tasks produced")
	}

	// Sources are no longer needed once normalized.
	os.RemoveAll(srcDir)

	benchmark := &model.Benchmark{
		ID:               benchmarkID,
		UserID:           actor.ID,
		Name:             name,
		OriginalFilename: filepath.Base(files[0].Filename),
		FileSize:         totalSize,
		FileCount:        len(files),
		FileChecksum:     checksum,
		FileExt:          strings.ToLower(filepath.Ext(files[0].Filename)),
		Compressors:      instances,
	}

	if err := s.benchRepo.Create(ctx, benchmark); err != nil {
		cleanup()
		return nil, fmt.Errorf("create benchmark: %w", err)
	}
	if err := s.taskRepo.CreateBatch(ctx, tasks); err != nil {
		_ = s.benchRepo.Delete(ctx, benchmarkID)
		cleanup()
		return nil, fmt.Errorf("create tasks: %w", err)
	}

	return benchmark, nil
}

// resolvedInstance pairs a validated instance with its option schema and, for
// user packages, the resolved package row.
type resolvedInstance struct {
	Instance compressor.Instance
	Schema   map[string]compressor.Option
	Package  *model.CompressorPackage
}

// resolveInstances parses, canonicalizes and validates the configured
// compressor instances, rejecting duplicate configurations.
func (s *BenchmarkService) resolveInstances(ctx context.Context, actor *model.User, compressorsJSON []byte) ([]resolvedInstance, error) {
	instances, err := compressor.ParseInstances(compressorsJSON)
	if err != nil {
		return nil, err
	}
	if len(instances) == 0 {
		return nil, fmt.Errorf("no compressors selected")
	}
	if len(instances) > compressor.MaxInstancesPerBenchmark {
		return nil, fmt.Errorf("at most %d compressor configurations are allowed per benchmark", compressor.MaxInstancesPerBenchmark)
	}

	takenLabels := make(map[string]bool, len(instances))
	seenBuiltin := make(map[string]bool, len(instances))
	seenCustom := make(map[string]bool, len(instances))
	resolved := make([]resolvedInstance, 0, len(instances))

	for _, inst := range instances {
		name := strings.ToLower(strings.TrimSpace(inst.Name))
		if name == "" {
			return nil, fmt.Errorf("compressor name is required")
		}

		var schema map[string]compressor.Option
		var pkg *model.CompressorPackage
		if compressor.IsValid(name) {
			schema = compressor.Registry[name]
		} else {
			pkg, err = s.pkgRepo.FindVisibleReadyByName(ctx, name, actor.ID, actor.GroupID, actor.Role == model.RoleAdmin)
			if err != nil {
				return nil, fmt.Errorf("validate compressor %s: %w", name, err)
			}
			if pkg == nil {
				return nil, fmt.Errorf("unknown compressor: %s", name)
			}
			if pkg.Workers > s.cfg.MaxParallelism {
				return nil, fmt.Errorf("compressor %s requires %d workers, more than the %d available", name, pkg.Workers, s.cfg.MaxParallelism)
			}
			var spec compressor.PackageSpec
			if err := json.Unmarshal(pkg.Spec, &spec); err != nil {
				return nil, fmt.Errorf("decode package spec %s: %w", name, err)
			}
			schema = spec.Options
			if schema == nil {
				schema = map[string]compressor.Option{}
			}
		}

		values, err := compressor.CanonicalizeOptions(schema, inst.Options)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}

		if pkg == nil {
			invocation := compressor.BuildInvocation(name, schema, values)
			if seenBuiltin[invocation] {
				return nil, fmt.Errorf("duplicate configuration for compressor %s", name)
			}
			seenBuiltin[invocation] = true
		} else {
			canonical, _ := json.Marshal(values)
			key := name + "\x00" + string(canonical)
			if seenCustom[key] {
				return nil, fmt.Errorf("duplicate configuration for compressor %s", name)
			}
			seenCustom[key] = true
		}

		label := compressor.WithUniqueLabel(compressor.BuildLabel(name, schema, values), takenLabels)
		resolved = append(resolved, resolvedInstance{
			Instance: compressor.Instance{Name: name, Options: values, Label: label},
			Schema:   schema,
			Package:  pkg,
		})
	}
	return resolved, nil
}

func (s *BenchmarkService) ListBenchmarks(ctx context.Context, userID *uuid.UUID, cursor *time.Time, search, status string, limit int) (*repository.ListBenchmarksResult, error) {
	return s.benchRepo.List(ctx, repository.ListBenchmarksParams{
		UserID: userID,
		Cursor: cursor,
		Search: search,
		Status: status,
		Limit:  limit,
	})
}

func (s *BenchmarkService) GetBenchmark(ctx context.Context, id uuid.UUID) (*model.BenchmarkDetailResponse, error) {
	benchmark, err := s.benchRepo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if benchmark == nil {
		return nil, nil
	}

	results, err := s.resultRepo.FindByBenchmarkID(ctx, id)
	if err != nil {
		return nil, err
	}

	return &model.BenchmarkDetailResponse{
		Benchmark: benchmark,
		Results:   results,
	}, nil
}

func (s *BenchmarkService) GetBenchmarkStatus(ctx context.Context, id uuid.UUID) (*model.Benchmark, error) {
	return s.benchRepo.FindByID(ctx, id)
}

func (s *BenchmarkService) CompareBenchmarks(ctx context.Context, ids []uuid.UUID) (*model.CompareResponse, error) {
	if len(ids) > 5 {
		ids = ids[:5]
	}

	benchmarks := make([]*model.Benchmark, 0, len(ids))
	for _, id := range ids {
		b, err := s.benchRepo.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if b != nil && b.Status == "ready" {
			benchmarks = append(benchmarks, b)
		}
	}

	resultIDs := make([]uuid.UUID, len(benchmarks))
	for i, b := range benchmarks {
		resultIDs[i] = b.ID
	}

	results, err := s.resultRepo.FindByBenchmarkIDs(ctx, resultIDs)
	if err != nil {
		return nil, err
	}

	resultsMap := make(map[string][]*model.BenchmarkResult)
	for id, res := range results {
		resultsMap[id.String()] = res
	}

	return &model.CompareResponse{
		Benchmarks: benchmarks,
		Results:    resultsMap,
	}, nil
}

func (s *BenchmarkService) ListChecksums(ctx context.Context) ([]string, error) {
	return s.benchRepo.ListChecksums(ctx)
}

func (s *BenchmarkService) GetStatus(ctx context.Context) (*model.StatusResponse, error) {
	return s.GetUserStatus(ctx, nil)
}

func (s *BenchmarkService) GetUserStatus(ctx context.Context, userID *uuid.UUID) (*model.StatusResponse, error) {
	globalStats, err := s.benchRepo.GetStatusStats(ctx)
	if err != nil {
		return nil, err
	}

	running := 0
	if s.runningFunc != nil {
		running = s.runningFunc()
	}

	// Default: user stats = global stats (for admin or anonymous)
	var userStats model.StatusStats
	if userID != nil {
		stats, err := s.benchRepo.GetUserStatusStats(ctx, *userID)
		if err == nil {
			userStats = *stats
		}
	} else {
		userStats = *globalStats
	}

	return &model.StatusResponse{
		QueueDepth: globalStats.Queued,
		Runner: model.RunnerStatus{
			Running:        running,
			MaxParallelism: s.cfg.MaxParallelism,
		},
		Stats: userStats,
		CPU:   CollectCPUStatus(),
	}, nil
}
