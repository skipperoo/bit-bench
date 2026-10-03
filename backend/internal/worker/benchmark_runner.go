package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"bitbench/internal/compressor"
	"bitbench/internal/config"
	"bitbench/internal/logger"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/runner"
	"bitbench/internal/service"
)

// ContainerRunner executes sandboxed container specs; implemented by runner.DockerRunner.
type ContainerRunner interface {
	Run(ctx context.Context, spec runner.Spec) (*runner.Result, error)
}

type BenchmarkRunner struct {
	cfg        *config.Config
	db         *pgxpool.Pool
	rdb        *redis.Client
	benchRepo  *repository.BenchmarkRepository
	resultRepo *repository.BenchmarkResultRepository
	pkgRepo    *repository.CompressorPackageRepository
	slots      *SlotPool
	container  ContainerRunner
	running    atomic.Int32
}

func NewBenchmarkRunner(cfg *config.Config, db *pgxpool.Pool, rdb *redis.Client) *BenchmarkRunner {
	return &BenchmarkRunner{
		cfg:        cfg,
		db:         db,
		rdb:        rdb,
		benchRepo:  repository.NewBenchmarkRepository(db),
		resultRepo: repository.NewBenchmarkResultRepository(db),
		pkgRepo:    repository.NewCompressorPackageRepository(db),
		slots:      NewSlotPool(cfg.MaxRunnerWorkers),
	}
}

func (r *BenchmarkRunner) SetContainerRunner(cr ContainerRunner) {
	r.container = cr
}

func (r *BenchmarkRunner) Slots() *SlotPool {
	return r.slots
}

func (r *BenchmarkRunner) Run(ctx context.Context) {
	logger.Info("benchmark runner starting", "parallelism", r.cfg.MaxParallelism)

	sem := make(chan struct{}, r.cfg.MaxParallelism)

	for {
		select {
		case <-ctx.Done():
			logger.Info("benchmark runner stopped")
			return
		case sem <- struct{}{}:
			go func() {
				defer func() { <-sem }()
				r.processNext(ctx)
			}()
		}
	}
}

func (r *BenchmarkRunner) Running() int {
	return int(r.running.Load())
}

func (r *BenchmarkRunner) processNext(ctx context.Context) {
	benchID, err := r.claimJob(ctx)
	if err != nil {
		logger.Error("claim job", "error", err)
		return
	}
	if benchID == nil {
		time.Sleep(2 * time.Second)
		return
	}

	r.running.Add(1)
	defer r.running.Add(-1)
	r.executeJob(ctx, *benchID)
}

func (r *BenchmarkRunner) claimJob(ctx context.Context) (*uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT b.id FROM benchmarks b
		LEFT JOIN users u ON u.id = b.user_id
		LEFT JOIN groups g ON g.id = u.group_id
		WHERE b.status = 'queued'
		ORDER BY COALESCE(g.priority, 0) DESC, b.created_at ASC
		FOR UPDATE OF b SKIP LOCKED
		LIMIT 1
	`).Scan(&id)

	if err != nil {
		tx.Rollback(ctx)
		return nil, nil
	}

	tag, err := tx.Exec(ctx, `
		UPDATE benchmarks SET status = 'in_progress', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
		WHERE id = $1 AND status = 'queued'
	`, id)
	if err != nil {
		return nil, fmt.Errorf("update status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		tx.Rollback(ctx)
		return nil, nil
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit claim: %w", err)
	}

	return &id, nil
}

func (r *BenchmarkRunner) executeJob(ctx context.Context, id uuid.UUID) {
	logger.Info("processing benchmark", "id", id)

	// Mark progress as started (2% — loading)
	r.updateProgress(ctx, id, 2)

	benchmark, err := r.benchRepo.FindByID(ctx, id)
	if err != nil || benchmark == nil {
		logger.Error("find benchmark", "id", id, "error", err)
		return
	}

	workDir := filepath.Join(r.cfg.DataDir, id.String())
	os.MkdirAll(workDir, 0755)

	// Locate the uploaded file using the stored filename pattern
	srcName := service.StoredFilename(benchmark.OriginalFilename, benchmark.FileChecksum)
	srcPath := filepath.Join(r.cfg.DataDir, srcName)

	// Normalize to .bin files
	binPaths, err := NormalizeFile(srcPath, workDir, benchmark.FileExt)
	if err != nil {
		r.failJob(ctx, id, fmt.Sprintf("normalize: %v", err), workDir)
		return
	}

	builtinCompressors := make(map[string]interface{})
	customCompressors := make(map[string]interface{})
	for name, opts := range benchmark.Compressors {
		if compressor.IsValid(name) {
			builtinCompressors[name] = opts
		} else {
			customCompressors[name] = opts
		}
	}

	compressorList := BuildCompressorList(builtinCompressors)
	if compressorList == "" && len(customCompressors) == 0 {
		r.failJob(ctx, id, "no compressors selected", workDir)
		return
	}

	// The native benchmark binary is only needed for built-in compressors.
	binaryPath := r.cfg.BenchBinaryPath
	if compressorList != "" {
		if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
			// Try fallback
			fallback := strings.Replace(binaryPath, "LosslessBenchmarkFull", "LosslessBenchmark", 1)
			if _, err := os.Stat(fallback); err == nil {
				binaryPath = fallback
			} else {
				r.failJob(ctx, id, fmt.Sprintf("benchmark binary not found: %s", binaryPath), workDir)
				return
			}
		}
	}

	// Progress: files ready, about to run benchmark
	r.updateProgress(ctx, id, 5)

	// Run benchmark for each .bin file
	var allRows []BenchmarkRow
	var lastErr string

	r.updateProgress(ctx, id, 8)

	// Count total compressor runs for progress tracking (compressors × bin files)
	totalCompRuns := (len(builtinCompressors) + len(customCompressors)) * len(binPaths)
	compCompleted := 0
	compProgressFn := func(compressorName string) {
		compCompleted++
		if totalCompRuns > 0 {
			pct := 8 + compCompleted*27/totalCompRuns
			r.updateProgress(ctx, id, pct)
		}
	}

	if compressorList != "" {
		for attempt := 0; attempt <= r.cfg.BenchMaxRetries; attempt++ {
			if attempt > 0 {
				logger.Info("retrying benchmark", "id", id, "attempt", attempt)
				time.Sleep(1 * time.Second)
			}

			allRows = nil
			var hadError bool

			for _, binPath := range binPaths {
				result, err := RunBenchmark(binaryPath, compressorList, binPath, workDir, r.cfg.BenchTimeout, compProgressFn)
				if err != nil {
					lastErr = fmt.Sprintf("exec error: %v", err)
					hadError = true
					break
				}

				if result.ExitCode == 124 {
					// Timeout
					r.benchRepo.UpdateStatus(ctx, id, "timed_out", strPtr(fmt.Sprintf("timeout after %ds", int(r.cfg.BenchTimeout.Seconds()))))
					r.cleanup(workDir, srcPath)
					logger.Warn("benchmark timed out", "id", id)
					return
				}

				if result.ExitCode != 0 {
					lastErr = fmt.Sprintf("exit code %d: %s", result.ExitCode, truncate(result.Stderr, 500))
					hadError = true
					break
				}

				if result.CSVPath == "" {
					lastErr = "no CSV output produced"
					hadError = true
					break
				}

				// Parse CSV
				f, err := os.Open(result.CSVPath)
				if err != nil {
					lastErr = fmt.Sprintf("open csv: %v", err)
					hadError = true
					break
				}

				rows, err := ParseCSV(f)
				f.Close()
				if err != nil {
					lastErr = fmt.Sprintf("parse csv: %v", err)
					hadError = true
					break
				}

				allRows = append(allRows, rows...)
			}

			if !hadError {
				break
			}
		}

		if allRows == nil {
			r.failJob(ctx, id, lastErr, workDir)
			return
		}
	}

	// Run user-provided compressors in sandboxed containers.
	for name, opts := range customCompressors {
		pkg, err := r.pkgRepo.FindByName(ctx, name)
		if err != nil {
			r.failJob(ctx, id, fmt.Sprintf("load compressor %s: %v", name, err), workDir)
			return
		}
		if pkg == nil || pkg.Status != "ready" {
			r.failJob(ctx, id, fmt.Sprintf("compressor %s is not ready", name), workDir)
			return
		}
		optMap, _ := opts.(map[string]interface{})

		for _, binPath := range binPaths {
			rows, err := r.runCustomCompressor(ctx, pkg, name, binPath, workDir, optMap)
			if err != nil {
				if errors.Is(err, runner.ErrTimeout) {
					r.benchRepo.UpdateStatus(ctx, id, "timed_out", strPtr(fmt.Sprintf("timeout after %ds", int(r.cfg.BenchTimeout.Seconds()))))
					r.cleanup(workDir, srcPath)
					logger.Warn("custom compressor timed out", "id", id, "compressor", name)
					return
				}
				r.failJob(ctx, id, fmt.Sprintf("custom compressor %s: %v", name, err), workDir)
				return
			}
			allRows = append(allRows, rows...)
			compProgressFn(name)
		}
	}

	if len(allRows) == 0 {
		r.failJob(ctx, id, "no benchmark results produced", workDir)
		return
	}

	// Average rows per compressor
	averaged := AverageRows(allRows)

	// Get original built-in compressor names for MemoryHarness (lowercase).
	// Custom compressors cannot be introspected by the native harness.
	originalCompNames := make([]string, 0, len(builtinCompressors))
	for name, opts := range builtinCompressors {
		optMap, _ := opts.(map[string]interface{})
		baseName := mapCompressorName(name, optMap)
		originalCompNames = append(originalCompNames, baseName)
	}

	// Mark progress: performance benchmark done
	r.updateProgress(ctx, id, 35)

	// Progress: about to start memory measurements
	r.updateProgress(ctx, id, 40)

	// Run memory measurements (Valgrind Massif-based)
	memoryResults := r.runMemoryMeasurements(ctx, id, binaryPath, originalCompNames, binPaths, workDir)

	// Progress: memory done, inserting results
	r.updateProgress(ctx, id, 90)

	// Insert results
	var lastInsertErr error
	dataset := strings.TrimSuffix(benchmark.OriginalFilename, "."+benchmark.FileExt)
	for _, row := range averaged {
		rangeJSON, _ := json.Marshal(row.RangeQueries)

		res := &model.BenchmarkResult{
			BenchmarkID:                id,
			Compressor:                 row.Compressor,
			Dataset:                    dataset,
			NumValues:                  int64Ptr(row.NumValues),
			OriginalSize:               int64Ptr(row.OriginalSize),
			UncompressedBits:           int64Ptr(row.UncompressedBits),
			CompressedBits:             int64Ptr(row.CompressedBits),
			CompressionRatio:           float64Ptr(row.CompressionRatio),
			CompressionThroughputMbs:   float64Ptr(row.CompressionThroughputMbs),
			DecompressionThroughputMbs: float64Ptr(row.DecompressionThroughputMbs),
			RangeQueries:               rangeJSON,
		}
		if !row.Missing["memory_usage"] {
			res.MemoryUsage = int64Ptr(row.MemoryUsage)
		}
		if !row.Missing["random_access_ns"] {
			res.RandomAccessNs = float64Ptr(row.RandomAccessNs)
		}
		if !row.Missing["random_access_mbs"] {
			res.RandomAccessMbs = float64Ptr(row.RandomAccessMbs)
		}

		// Override memory_usage with Massif measurement if available.
		// Match by lowercasing the display name from CSV to find the original name.
		lcComp := strings.ToLower(row.Compressor)
		if memRes, ok := memoryResults[strings.ToLower(row.Compressor)]; ok {
			res.InputBuffer = int64Ptr(memRes.InputBufferBytes)
			res.CompressorInternal = int64Ptr(memRes.CompressorInternal)
			res.MemoryUsage = int64Ptr(memRes.PeakMemoryBytes)
			res.InternalMemoryRatio = computeInternalMemoryRatio(memRes.CompressorInternal, memRes.InputBufferBytes)
			res.RelativeMemoryUsage = computeRelativeMemoryUsage(memRes.PeakMemoryBytes, memRes.InputBufferBytes)
		} else if memRes, ok := memoryResults[lcComp]; ok {
			res.InputBuffer = int64Ptr(memRes.InputBufferBytes)
			res.CompressorInternal = int64Ptr(memRes.CompressorInternal)
			res.MemoryUsage = int64Ptr(memRes.PeakMemoryBytes)
			res.InternalMemoryRatio = computeInternalMemoryRatio(memRes.CompressorInternal, memRes.InputBufferBytes)
			res.RelativeMemoryUsage = computeRelativeMemoryUsage(memRes.PeakMemoryBytes, memRes.InputBufferBytes)
		}

		if err := r.resultRepo.Insert(ctx, res); err != nil {
			lastInsertErr = err
			logger.Error("insert result", "compressor", row.Compressor, "error", err)
		}
	}

	if lastInsertErr != nil {
		r.failJob(ctx, id, fmt.Sprintf("insert results: %v", lastInsertErr), workDir)
		return
	}

	// Mark as ready
	if err := r.benchRepo.UpdateStatus(ctx, id, "ready", nil); err != nil {
		logger.Error("update status to ready", "id", id, "error", err)
	}

	// Cleanup
	r.cleanup(workDir, srcPath)

	logger.Info("benchmark completed", "id", id, "results", len(averaged))
}

// runCustomCompressor executes a user-provided compressor package in a runner
// container against a single .bin file and parses its CSV output.
func (r *BenchmarkRunner) runCustomCompressor(ctx context.Context, pkg *model.CompressorPackage, name, binPath, workDir string, provided map[string]interface{}) ([]BenchmarkRow, error) {
	if pkg.BuiltPath == nil {
		return nil, fmt.Errorf("package has no build artifact")
	}
	if pkg.Workers > r.cfg.MaxRunnerWorkers {
		return nil, fmt.Errorf("requires %d workers, maximum is %d", pkg.Workers, r.cfg.MaxRunnerWorkers)
	}
	if r.container == nil {
		return nil, fmt.Errorf("container runner unavailable")
	}

	if err := r.slots.Acquire(ctx, pkg.Workers); err != nil {
		return nil, fmt.Errorf("acquire workers: %w", err)
	}
	defer r.slots.Release(pkg.Workers)

	var spec compressor.PackageSpec
	if err := json.Unmarshal(pkg.Spec, &spec); err != nil {
		return nil, fmt.Errorf("decode package spec: %w", err)
	}
	options := mergeOptions(spec.Options, provided)

	customDir := filepath.Join(workDir, "custom")
	if err := os.MkdirAll(customDir, 0777); err != nil {
		return nil, err
	}
	_ = os.Chmod(customDir, 0777)
	// The runner container executes as uid 1000 and must be able to write.
	_ = os.Chown(customDir, 1000, 1000)

	optionsPath := filepath.Join(customDir, name+"_options.json")
	optJSON, err := marshalOptions(options)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(optionsPath, optJSON, 0644); err != nil {
		return nil, err
	}

	outPath := filepath.Join(customDir, name+".csv")
	command := buildCustomCommand(pkg.Entrypoint, options, outPath, optionsPath, binPath)

	runCtx, cancel := context.WithTimeout(ctx, r.cfg.BenchTimeout)
	defer cancel()

	result, err := r.container.Run(runCtx, runner.Spec{
		Mounts: []runner.Mount{
			volumeOrBind(r.cfg.CompressorDir, r.cfg.CompressorVolume, true),
			volumeOrBind(r.cfg.DataDir, r.cfg.BenchVolume, false),
		},
		WorkingDir:     filepath.Join(r.cfg.CompressorDir, *pkg.BuiltPath, "pkg"),
		Command:        command,
		Env:            []string{"HOME=/tmp", "TMPDIR=/tmp"},
		User:           "1000",
		Workers:        pkg.Workers,
		KillOnThrottle: true,
	})
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("exit code %d: %s", result.ExitCode, truncate(result.Logs, 500))
	}

	f, err := os.Open(outPath)
	if err != nil {
		return nil, fmt.Errorf("open output csv: %w", err)
	}
	defer f.Close()

	rows, err := ParseCSVLenient(f)
	if err != nil {
		return nil, fmt.Errorf("parse output csv: %w", err)
	}
	for i := range rows {
		rows[i].Compressor = name
	}
	return rows, nil
}

func (r *BenchmarkRunner) failJob(ctx context.Context, id uuid.UUID, errMsg string, workDir string) {
	logger.Error("benchmark failed", "id", id, "error", errMsg)

	// Try to update status; if retries remain, the runner will re-claim
	benchmark, _ := r.benchRepo.FindByID(ctx, id)
	if benchmark != nil {
		// Check if we've already retried enough
		// For now, just mark as failed
		r.benchRepo.UpdateStatus(ctx, id, "failed", &errMsg)
	}

	r.cleanup(workDir, "")
}

func (r *BenchmarkRunner) cleanup(workDir string, srcPath string) {
	if srcPath != "" {
		os.Remove(srcPath)
	}
	os.RemoveAll(workDir)
}

// updateProgress sets the progress in DB.
func (r *BenchmarkRunner) updateProgress(ctx context.Context, id uuid.UUID, progress int) {
	r.benchRepo.UpdateProgress(ctx, id, progress)
}

// runMemoryMeasurements runs the MemoryHarness under Valgrind Massif for each
// compressor, returning a map of compressor name to memory result.
func (r *BenchmarkRunner) runMemoryMeasurements(ctx context.Context, id uuid.UUID, binaryPath string, compressorNames []string, binPaths []string, workDir string) map[string]*MemoryResult {
	// Find the MemoryHarness binary
	memBinaryPath := r.cfg.BenchBinaryPath
	memBinaryPath = strings.Replace(memBinaryPath, "LosslessBenchmarkFull", "MemoryHarness", 1)
	memBinaryPath = strings.Replace(memBinaryPath, "LosslessBenchmark", "MemoryHarness", 1)

	if _, err := os.Stat(memBinaryPath); os.IsNotExist(err) {
		logger.Warn("MemoryHarness binary not found, skipping memory measurements", "path", memBinaryPath)
		return nil
	}

	massifDir := filepath.Join(workDir, "massif")
	timeout := r.cfg.BenchTimeout

	// Memory measurement progress: 50 → 100% across all compressors
	numComps := len(compressorNames)
	results := make(map[string]*MemoryResult)
	baselineCache := make(map[string]int64)

	if err := os.MkdirAll(massifDir, 0755); err != nil {
		logger.Warn("memory measurements: mkdir", "error", err)
		return nil
	}

	if len(binPaths) == 0 {
		return nil
	}
	binPath := binPaths[0]

	for i, comp := range compressorNames {
		result, err := RunMemoryHarnessWithBaseline(memBinaryPath, comp, binPath, massifDir, timeout, baselineCache)
		if err != nil {
			logger.Warn("memory measurement failed", "compressor", comp, "error", err)
			continue
		}
		baseName := comp
		if eqIdx := strings.IndexByte(comp, '='); eqIdx >= 0 {
			baseName = comp[:eqIdx]
		}
		result.Compressor = baseName
		results[baseName] = result

		// Update progress: memory portion spans 40→85%
		pct := 40 + (i+1)*45/numComps
		r.updateProgress(ctx, id, pct)
	}

	os.RemoveAll(massifDir)

	if len(results) == 0 {
		return nil
	}

	logger.Info("memory measurements completed", "id", id, "count", len(results))
	return results
}

func strPtr(s string) *string {
	return &s
}

func int64Ptr(i int64) *int64 {
	return &i
}

func float64Ptr(f float64) *float64 {
	return &f
}

func truncate(s string, maxLen int) string {
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}
