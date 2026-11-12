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
	"bitbench/internal/logger"
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
	presets     *PresetService
	cfg         *config.Config
	runningFunc func() int
}

func NewBenchmarkService(br *repository.BenchmarkRepository, rr *repository.BenchmarkResultRepository, pr *repository.CompressorPackageRepository, tr *repository.BenchmarkTaskRepository, presets *PresetService, cfg *config.Config) *BenchmarkService {
	return &BenchmarkService{benchRepo: br, resultRepo: rr, pkgRepo: pr, taskRepo: tr, presets: presets, cfg: cfg}
}

// UploadedFile is one file of a (possibly multi-file) benchmark upload.
type UploadedFile struct {
	Reader   io.ReadSeeker
	Filename string
}

func (s *BenchmarkService) SetRunningFunc(fn func() int) {
	s.runningFunc = fn
}

// maxExtractedBytes caps how much one archive may expand to (zip-bomb guard):
// 20x the per-file upload limit.
func (s *BenchmarkService) maxExtractedBytes() int64 {
	if s.cfg.MaxFileSizeMB <= 0 {
		return 0
	}
	return s.cfg.MaxFileSizeMB * 20 * 1024 * 1024
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

// BenchmarkOptions are the per-benchmark run settings shared by uploads and
// dataset runs.
type BenchmarkOptions struct {
	// Aggregation combines per-input rows ("mean", "median", "pooled");
	// empty means "mean".
	Aggregation string
	// MeasureMemory runs the Valgrind Massif memory harness for built-ins.
	MeasureMemory bool
	// ExperimentID groups benchmarks created by one submission; zero means a
	// new experiment containing only this benchmark.
	ExperimentID uuid.UUID
}

// DefaultBenchmarkOptions are the settings used when a client sends none.
func DefaultBenchmarkOptions() BenchmarkOptions {
	return BenchmarkOptions{Aggregation: "mean", MeasureMemory: true}
}

func (o *BenchmarkOptions) normalize() error {
	o.Aggregation = strings.ToLower(strings.TrimSpace(o.Aggregation))
	if o.Aggregation == "" {
		o.Aggregation = "mean"
	}
	switch o.Aggregation {
	case "mean", "median", "pooled":
		return nil
	}
	return fmt.Errorf("unknown aggregation %q (want mean, median or pooled)", o.Aggregation)
}

// CreateBenchmark creates a benchmark from uploaded files with the default
// options.
func (s *BenchmarkService) CreateBenchmark(ctx context.Context, actor *model.User, name string, files []UploadedFile, compressorsJSON []byte) (*model.Benchmark, error) {
	return s.CreateBenchmarkWithOptions(ctx, actor, name, files, compressorsJSON, DefaultBenchmarkOptions())
}

// CreateBenchmarkWithOptions validates and normalizes uploaded files to .bin
// inputs and enqueues one benchmark.
func (s *BenchmarkService) CreateBenchmarkWithOptions(ctx context.Context, actor *model.User, name string, files []UploadedFile, compressorsJSON []byte, opts BenchmarkOptions) (*model.Benchmark, error) {
	if actor == nil {
		return nil, fmt.Errorf("unauthorized")
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("at least one file is required")
	}
	if err := opts.normalize(); err != nil {
		return nil, err
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
	resolved, err := resolveInstances(ctx, s.pkgRepo, s.cfg.MaxParallelism, s.cfg.HostPlatform, actor, compressorsJSON)
	if err != nil {
		return nil, err
	}

	benchmarkID := uuid.New()
	workRoot := filepath.Join(s.cfg.DataDir, benchmarkID.String())
	srcDir := filepath.Join(workRoot, "sources")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
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
		// One folder per upload keeps the original file name (it ends up in the
		// harness' dataset column and the task view) while avoiding clashes.
		fileDir := filepath.Join(srcDir, fmt.Sprintf("%02d", i))
		if err := os.MkdirAll(fileDir, 0755); err != nil {
			cleanup()
			return nil, fmt.Errorf("store file: %w", err)
		}
		srcPath := filepath.Join(fileDir, base+ext)

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
		bins, err := seqfile.NormalizeFileLimit(srcPath, inputDir, ext, s.maxExtractedBytes())
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("normalize %s: %w", file.Filename, err)
		}
		binPaths = append(binPaths, bins...)
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
		FileChecksum:     hex.EncodeToString(hasher.Sum(nil)),
		FileExt:          strings.ToLower(filepath.Ext(files[0].Filename)),
		Aggregation:      opts.Aggregation,
		MeasureMemory:    opts.MeasureMemory,
		ExperimentID:     opts.ExperimentID,
	}
	if err := s.enqueue(ctx, benchmark, binPaths, resolved); err != nil {
		cleanup()
		return nil, err
	}

	s.recordHistory(ctx, actor, benchmark.Compressors)
	return benchmark, nil
}

// enqueue inserts a benchmark plus its tasks: one built-in task per .bin (all
// built-in instances batched) and one task per (custom package instance x
// .bin), each costing its worker count.
func (s *BenchmarkService) enqueue(ctx context.Context, benchmark *model.Benchmark, binPaths []string, resolved []resolvedInstance) error {
	instances := make([]compressor.Instance, 0, len(resolved))
	builtinCount := 0
	for _, r := range resolved {
		instances = append(instances, r.Instance)
		if r.Package == nil {
			builtinCount++
		}
	}
	if len(instances) == 0 {
		return fmt.Errorf("no compressors selected")
	}
	benchmark.Compressors = instances

	var tasks []*model.BenchmarkTask
	seq := 0
	for _, binPath := range binPaths {
		rel, err := filepath.Rel(s.cfg.DataDir, binPath)
		if err != nil {
			return fmt.Errorf("resolve task input: %w", err)
		}
		if builtinCount > 0 {
			seq++
			tasks = append(tasks, &model.BenchmarkTask{
				BenchmarkID: benchmark.ID,
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
				BenchmarkID:   benchmark.ID,
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
		return fmt.Errorf("no benchmark tasks produced")
	}

	if err := s.benchRepo.Create(ctx, benchmark); err != nil {
		return fmt.Errorf("create benchmark: %w", err)
	}
	if err := s.taskRepo.CreateBatch(ctx, tasks); err != nil {
		_ = s.benchRepo.Delete(ctx, benchmark.ID)
		return fmt.Errorf("create tasks: %w", err)
	}
	return nil
}

// recordHistory stores the configuration in the user's history (best effort).
func (s *BenchmarkService) recordHistory(ctx context.Context, actor *model.User, instances []compressor.Instance) {
	if s.presets == nil {
		return
	}
	if err := s.presets.RecordHistory(ctx, actor.ID, instances); err != nil {
		logger.Warn("record config history", "user", actor.ID, "error", err)
	}
}

// resolvedInstance pairs a validated instance with its option schema and, for
// user packages, the resolved package row.
type resolvedInstance struct {
	Instance compressor.Instance
	Schema   map[string]compressor.Option
	Package  *model.CompressorPackage
}

// resolveInstances parses, canonicalizes and validates configured compressor
// instances, rejecting duplicate configurations.
func resolveInstances(ctx context.Context, pkgRepo *repository.CompressorPackageRepository, maxParallelism int, hostPlatform string, actor *model.User, compressorsJSON []byte) ([]resolvedInstance, error) {
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
		platform := hostPlatform
		if compressor.IsValid(name) {
			schema = compressor.Registry[name]
		} else {
			pkg, err = pkgRepo.FindVisibleReadyByName(ctx, name, actor.ID, actor.GroupID, actor.Role == model.RoleAdmin)
			if err != nil {
				return nil, fmt.Errorf("validate compressor %s: %w", name, err)
			}
			if pkg == nil {
				return nil, fmt.Errorf("unknown compressor: %s", name)
			}
			if pkg.Workers > maxParallelism {
				return nil, fmt.Errorf("compressor %s requires %d workers, more than the %d available", name, pkg.Workers, maxParallelism)
			}
			var spec compressor.PackageSpec
			if err := json.Unmarshal(pkg.Spec, &spec); err != nil {
				return nil, fmt.Errorf("decode package spec %s: %w", name, err)
			}
			schema = spec.Options
			if schema == nil {
				schema = map[string]compressor.Option{}
			}
			platform = compressor.ResolvePlatform(spec.Platform, hostPlatform)
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
		instance := compressor.Instance{Name: name, Options: values, Label: label}
		if pkg != nil {
			instance.Platform = platform
			instance.Emulated = platform != hostPlatform
		}
		resolved = append(resolved, resolvedInstance{
			Instance: instance,
			Schema:   schema,
			Package:  pkg,
		})
	}
	return resolved, nil
}

func (s *BenchmarkService) ListBenchmarks(ctx context.Context, p repository.ListBenchmarksParams) (*repository.ListBenchmarksResult, error) {
	return s.benchRepo.List(ctx, p)
}

// DeleteBenchmark removes a benchmark, its results and its work directory.
// Running tasks finish on their own; their results are discarded.
func (s *BenchmarkService) DeleteBenchmark(ctx context.Context, id uuid.UUID) error {
	os.RemoveAll(filepath.Join(s.cfg.DataDir, id.String()))
	return s.benchRepo.Delete(ctx, id)
}

// CancelBenchmark cancels a queued or running benchmark; it reports false when
// the benchmark already finished.
func (s *BenchmarkService) CancelBenchmark(ctx context.Context, id uuid.UUID, reason string) (bool, error) {
	return s.benchRepo.Cancel(ctx, id, reason)
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

// CompareBenchmarks loads the ready benchmarks among ids that actor may view
// (own benchmarks; every benchmark for admins).
func (s *BenchmarkService) CompareBenchmarks(ctx context.Context, actor *model.User, ids []uuid.UUID) (*model.CompareResponse, error) {
	if max := s.cfg.MaxCompare; max > 0 && len(ids) > max {
		ids = ids[:max]
	}

	benchmarks := make([]*model.Benchmark, 0, len(ids))
	for _, id := range ids {
		b, err := s.benchRepo.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if b == nil || b.Status != "ready" || actor == nil {
			continue
		}
		if actor.Role != model.RoleAdmin && b.UserID != actor.ID {
			continue
		}
		benchmarks = append(benchmarks, b)
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

// TaskView is the public, payload-free view of one benchmark task.
type TaskView struct {
	Seq        int        `json:"seq"`
	Kind       string     `json:"kind"`
	Compressor string     `json:"compressor"`
	Input      string     `json:"input"`
	Workers    int        `json:"workers"`
	Status     string     `json:"status"`
	Error      *string    `json:"error,omitempty"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// ListTasks returns the tasks of a running benchmark (task rows are deleted
// once the benchmark is finalized, so finished benchmarks return none).
func (s *BenchmarkService) ListTasks(ctx context.Context, benchmarkID uuid.UUID) ([]TaskView, error) {
	tasks, err := s.taskRepo.ListByBenchmark(ctx, benchmarkID)
	if err != nil {
		return nil, err
	}
	views := make([]TaskView, 0, len(tasks))
	for _, t := range tasks {
		v := TaskView{
			Seq: t.Seq, Kind: t.Kind, Input: filepath.Base(t.InputPath), Workers: t.Workers,
			Status: t.Status, Error: t.Error, StartedAt: t.StartedAt, FinishedAt: t.FinishedAt,
			Compressor: "built-in compressors",
		}
		if t.InstanceLabel != nil {
			v.Compressor = *t.InstanceLabel
		} else if t.Compressor != nil {
			v.Compressor = *t.Compressor
		}
		views = append(views, v)
	}
	return views, nil
}
