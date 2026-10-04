package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/compressor"
	"bitbench/internal/config"
	"bitbench/internal/logger"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/runner"
)

// ContainerRunner executes sandboxed container specs; implemented by runner.DockerRunner.
type ContainerRunner interface {
	Run(ctx context.Context, spec runner.Spec) (*runner.Result, error)
}

// errTaskTimeout marks a task that hit BENCH_TIMEOUT_SECONDS.
var errTaskTimeout = errors.New("task timed out")

// BenchmarkRunner is a worker-budget scheduler for benchmark tasks. The sum of
// the worker costs of all running tasks never exceeds the configured budget,
// and no task goroutine is spawned unless its cost fits in the free budget.
type BenchmarkRunner struct {
	cfg        *config.Config
	db         *pgxpool.Pool
	benchRepo  *repository.BenchmarkRepository
	resultRepo *repository.BenchmarkResultRepository
	pkgRepo    *repository.CompressorPackageRepository
	taskRepo   *repository.BenchmarkTaskRepository
	container  ContainerRunner
	budget     int
	running    atomic.Int32 // running worker units
	wake       chan struct{}

	binOnce  sync.Once
	binPath  string
	binReady bool
}

func NewBenchmarkRunner(cfg *config.Config, db *pgxpool.Pool) *BenchmarkRunner {
	budget := cfg.MaxParallelism
	if budget < 1 {
		budget = 1
	}
	return &BenchmarkRunner{
		cfg:        cfg,
		db:         db,
		benchRepo:  repository.NewBenchmarkRepository(db),
		resultRepo: repository.NewBenchmarkResultRepository(db),
		pkgRepo:    repository.NewCompressorPackageRepository(db),
		taskRepo:   repository.NewBenchmarkTaskRepository(db),
		budget:     budget,
		wake:       make(chan struct{}, 1),
	}
}

func (r *BenchmarkRunner) SetContainerRunner(cr ContainerRunner) {
	r.container = cr
}

// Running reports the worker units currently executing tasks.
func (r *BenchmarkRunner) Running() int {
	return int(r.running.Load())
}

// Budget returns the total worker units available to the scheduler.
func (r *BenchmarkRunner) Budget() int {
	return r.budget
}

func (r *BenchmarkRunner) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Run is the scheduler loop.
func (r *BenchmarkRunner) Run(ctx context.Context) {
	logger.Info("benchmark task scheduler starting", "workers", r.budget)

	if n, err := r.taskRepo.ResetRunning(ctx); err != nil {
		logger.Error("reset interrupted tasks", "error", err)
	} else if n > 0 {
		logger.Warn("requeued interrupted tasks", "count", n)
	}
	r.finalizeStranded(ctx)

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		r.dispatch(ctx)
		select {
		case <-ctx.Done():
			logger.Info("benchmark task scheduler stopped")
			return
		case <-r.wake:
		case <-ticker.C:
		}
	}
}

// dispatch claims and launches as many fitting tasks as the free budget allows.
func (r *BenchmarkRunner) dispatch(ctx context.Context) {
	for {
		free := r.budget - int(r.running.Load())
		if free < 1 {
			return
		}

		task, err := r.taskRepo.ClaimNext(ctx, free)
		if err != nil {
			logger.Error("claim task", "error", err)
			return
		}
		if task == nil {
			return
		}

		r.running.Add(int32(task.Workers))
		go func(t *model.BenchmarkTask) {
			defer func() {
				r.running.Add(int32(-t.Workers))
				r.signal()
			}()
			r.processTask(ctx, t)
		}(task)
	}
}

// finalizeStranded completes benchmarks stuck in_progress after a crash.
func (r *BenchmarkRunner) finalizeStranded(ctx context.Context) {
	ids, err := r.benchRepo.ListStrandedInProgress(ctx)
	if err != nil {
		logger.Error("list stranded benchmarks", "error", err)
		return
	}
	for _, id := range ids {
		logger.Warn("finalizing stranded benchmark", "id", id)
		r.finalize(ctx, id)
	}
}

func (r *BenchmarkRunner) processTask(ctx context.Context, task *model.BenchmarkTask) {
	benchmark, err := r.benchRepo.FindByID(ctx, task.BenchmarkID)
	if err != nil || benchmark == nil {
		logger.Error("load benchmark for task", "task", task.ID, "error", err)
		_ = r.taskRepo.Cancel(ctx, task.ID)
		return
	}

	if benchmark.Status == "cancelled" {
		_ = r.taskRepo.Cancel(ctx, task.ID)
		r.finalize(ctx, task.BenchmarkID)
		return
	}

	rows, err := r.runTask(ctx, benchmark, task)
	if err != nil {
		r.handleTaskError(ctx, task, err)
		return
	}

	payload, err := json.Marshal(rows)
	if err != nil {
		r.handleTaskError(ctx, task, fmt.Errorf("encode task result: %w", err))
		return
	}
	if err := r.taskRepo.Complete(ctx, task.ID, payload); err != nil {
		logger.Error("complete task", "task", task.ID, "error", err)
	}
	_ = r.benchRepo.UpdateProgressFromTasks(ctx, task.BenchmarkID)
	r.finalize(ctx, task.BenchmarkID)
}

func (r *BenchmarkRunner) handleTaskError(ctx context.Context, task *model.BenchmarkTask, taskErr error) {
	msg := taskErr.Error()
	_ = r.taskRepo.Fail(ctx, task.ID, msg)

	status := "failed"
	if errors.Is(taskErr, errTaskTimeout) {
		status = "timed_out"
		msg = fmt.Sprintf("timeout after %ds", int(r.cfg.BenchTimeout.Seconds()))
	}
	_ = r.benchRepo.UpdateStatus(ctx, task.BenchmarkID, status, &msg)
	_ = r.taskRepo.CancelQueuedForBenchmark(ctx, task.BenchmarkID)
	logger.Warn("benchmark task failed", "task", task.ID, "benchmark", task.BenchmarkID, "error", msg)
	r.finalize(ctx, task.BenchmarkID)
}

// finalize aggregates a benchmark once all of its tasks are terminal. It is
// safe to call concurrently: the benchmark row lock plus the per-task status
// update decide who aggregates and who cleans up.
func (r *BenchmarkRunner) finalize(ctx context.Context, benchmarkID uuid.UUID) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		logger.Error("finalize begin", "benchmark", benchmarkID, "error", err)
		return
	}
	defer tx.Rollback(ctx)

	var status, originalFilename, fileExt string
	err = tx.QueryRow(ctx, `
		SELECT status, original_filename, file_ext FROM benchmarks WHERE id = $1 FOR UPDATE
	`, benchmarkID).Scan(&status, &originalFilename, &fileExt)
	if err == pgx.ErrNoRows {
		return
	}
	if err != nil {
		logger.Error("finalize load benchmark", "benchmark", benchmarkID, "error", err)
		return
	}

	counts, err := taskCountsTx(ctx, tx, benchmarkID)
	if err != nil {
		logger.Error("finalize count tasks", "benchmark", benchmarkID, "error", err)
		return
	}
	if counts.Pending() > 0 {
		return
	}

	switch status {
	case "ready", "failed", "timed_out", "cancelled":
		// Already terminal: drop task rows and make sure progress is complete.
		if _, err := tx.Exec(ctx, `DELETE FROM benchmark_tasks WHERE benchmark_id = $1`, benchmarkID); err != nil {
			logger.Error("finalize cleanup tasks", "benchmark", benchmarkID, "error", err)
			return
		}
		if _, err := tx.Exec(ctx, `
			UPDATE benchmarks SET progress = 100, finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
			WHERE id = $1
		`, benchmarkID); err != nil {
			logger.Error("finalize touch benchmark", "benchmark", benchmarkID, "error", err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			logger.Error("finalize commit", "benchmark", benchmarkID, "error", err)
			return
		}
		r.cleanupWorkdir(benchmarkID)
		return
	}

	if counts.Total() == 0 || counts.Done == 0 || counts.Failed > 0 {
		msg := "benchmark produced no results"
		if counts.Failed > 0 {
			var taskErr *string
			_ = tx.QueryRow(ctx, `
				SELECT error FROM benchmark_tasks
				WHERE benchmark_id = $1 AND status = 'failed'
				ORDER BY seq ASC LIMIT 1
			`, benchmarkID).Scan(&taskErr)
			if taskErr != nil && *taskErr != "" {
				msg = *taskErr
			} else {
				msg = "benchmark task failed"
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE benchmarks SET status = 'failed', error = $2, finished_at = NOW(), progress = 100, updated_at = NOW()
			WHERE id = $1
		`, benchmarkID, msg); err != nil {
			logger.Error("finalize fail benchmark", "benchmark", benchmarkID, "error", err)
			return
		}
		if _, err := tx.Exec(ctx, `DELETE FROM benchmark_tasks WHERE benchmark_id = $1`, benchmarkID); err != nil {
			logger.Error("finalize cleanup tasks", "benchmark", benchmarkID, "error", err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			logger.Error("finalize commit", "benchmark", benchmarkID, "error", err)
			return
		}
		r.cleanupWorkdir(benchmarkID)
		return
	}

	// All tasks completed: average every task's rows into one row per compressor.
	results, err := doneResultsTx(ctx, tx, benchmarkID)
	if err != nil {
		logger.Error("finalize load results", "benchmark", benchmarkID, "error", err)
		return
	}
	var rows []BenchmarkRow
	for _, raw := range results {
		var taskRows []BenchmarkRow
		if err := json.Unmarshal(raw, &taskRows); err != nil {
			logger.Error("decode task result", "benchmark", benchmarkID, "error", err)
			continue
		}
		rows = append(rows, taskRows...)
	}
	if len(rows) == 0 {
		msg := "no benchmark results produced"
		if _, err := tx.Exec(ctx, `
			UPDATE benchmarks SET status = 'failed', error = $2, finished_at = NOW(), progress = 100, updated_at = NOW()
			WHERE id = $1
		`, benchmarkID, msg); err != nil {
			logger.Error("finalize fail benchmark", "benchmark", benchmarkID, "error", err)
			return
		}
		tx.Exec(ctx, `DELETE FROM benchmark_tasks WHERE benchmark_id = $1`, benchmarkID)
		if err := tx.Commit(ctx); err != nil {
			logger.Error("finalize commit", "benchmark", benchmarkID, "error", err)
			return
		}
		r.cleanupWorkdir(benchmarkID)
		return
	}

	dataset := strings.TrimSuffix(originalFilename, "."+strings.TrimPrefix(fileExt, "."))
	averaged := AverageRows(rows)
	for _, row := range averaged {
		res := rowToResult(benchmarkID, dataset, row)
		if err := r.resultRepo.InsertTx(ctx, tx, res); err != nil {
			logger.Error("insert result", "benchmark", benchmarkID, "compressor", row.Compressor, "error", err)
			_ = tx.Rollback(ctx)
			msg := fmt.Sprintf("persist results: %v", err)
			_ = r.benchRepo.UpdateStatus(ctx, benchmarkID, "failed", &msg)
			return
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE benchmarks SET status = 'ready', error = NULL, finished_at = NOW(), progress = 100, updated_at = NOW()
		WHERE id = $1
	`, benchmarkID); err != nil {
		logger.Error("finalize ready", "benchmark", benchmarkID, "error", err)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM benchmark_tasks WHERE benchmark_id = $1`, benchmarkID); err != nil {
		logger.Error("finalize cleanup tasks", "benchmark", benchmarkID, "error", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		logger.Error("finalize commit", "benchmark", benchmarkID, "error", err)
		return
	}

	r.cleanupWorkdir(benchmarkID)
	logger.Info("benchmark completed", "id", benchmarkID, "results", len(averaged))
}

func (r *BenchmarkRunner) cleanupWorkdir(benchmarkID uuid.UUID) {
	os.RemoveAll(filepath.Join(r.cfg.DataDir, benchmarkID.String()))
}

func taskCountsTx(ctx context.Context, tx pgx.Tx, benchmarkID uuid.UUID) (*repository.TaskCounts, error) {
	counts := &repository.TaskCounts{}
	err := tx.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'queued'),
			COUNT(*) FILTER (WHERE status = 'running'),
			COUNT(*) FILTER (WHERE status = 'done'),
			COUNT(*) FILTER (WHERE status = 'failed'),
			COUNT(*) FILTER (WHERE status = 'cancelled')
		FROM benchmark_tasks WHERE benchmark_id = $1
	`, benchmarkID).Scan(&counts.Queued, &counts.Running, &counts.Done, &counts.Failed, &counts.Cancelled)
	if err != nil {
		return nil, err
	}
	return counts, nil
}

func doneResultsTx(ctx context.Context, tx pgx.Tx, benchmarkID uuid.UUID) ([][]byte, error) {
	rows, err := tx.Query(ctx, `
		SELECT result FROM benchmark_tasks
		WHERE benchmark_id = $1 AND status = 'done' AND result IS NOT NULL
		ORDER BY seq ASC
	`, benchmarkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results [][]byte
	for rows.Next() {
		var result []byte
		if err := rows.Scan(&result); err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

// runTask executes one task and returns its parsed result rows.
func (r *BenchmarkRunner) runTask(ctx context.Context, benchmark *model.Benchmark, task *model.BenchmarkTask) ([]BenchmarkRow, error) {
	binPath := filepath.Join(r.cfg.DataDir, task.InputPath)
	if _, err := os.Stat(binPath); err != nil {
		return nil, fmt.Errorf("task input missing: %w", err)
	}

	taskDir := filepath.Join(r.cfg.DataDir, task.BenchmarkID.String(), "tasks", task.ID.String())
	if err := os.MkdirAll(taskDir, 0755); err != nil {
		return nil, fmt.Errorf("create task dir: %w", err)
	}
	defer os.RemoveAll(taskDir)

	switch task.Kind {
	case model.TaskKindBuiltin:
		return r.runBuiltinTask(ctx, benchmark, binPath, taskDir)
	case model.TaskKindCustom:
		return r.runCustomTask(ctx, benchmark, task, binPath, taskDir)
	default:
		return nil, fmt.Errorf("unknown task kind %q", task.Kind)
	}
}

// runBuiltinTask runs every built-in compressor for one .bin plus the memory
// measurements for that .bin.
func (r *BenchmarkRunner) runBuiltinTask(ctx context.Context, benchmark *model.Benchmark, binPath, taskDir string) ([]BenchmarkRow, error) {
	builtin := make(map[string]interface{})
	for name, opts := range benchmark.Compressors {
		if compressor.IsValid(name) {
			builtin[name] = opts
		}
	}
	if len(builtin) == 0 {
		return nil, fmt.Errorf("no built-in compressors selected")
	}

	binaryPath, err := r.resolveBinary()
	if err != nil {
		return nil, err
	}
	compressorList := BuildCompressorList(builtin)

	var rows []BenchmarkRow
	for attempt := 0; attempt <= r.cfg.BenchMaxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Second)
		}

		result, err := RunBenchmark(binaryPath, compressorList, binPath, taskDir, r.cfg.BenchTimeout, nil)
		if err != nil {
			return nil, fmt.Errorf("exec error: %w", err)
		}
		if result.ExitCode == 124 {
			return nil, errTaskTimeout
		}
		if result.ExitCode != 0 {
			if attempt == r.cfg.BenchMaxRetries {
				return nil, fmt.Errorf("exit code %d: %s", result.ExitCode, truncate(result.Stderr, 500))
			}
			continue
		}
		if result.CSVPath == "" {
			return nil, fmt.Errorf("no CSV output produced")
		}

		f, err := os.Open(result.CSVPath)
		if err != nil {
			return nil, fmt.Errorf("open csv: %w", err)
		}
		parsed, parseErr := ParseCSV(f)
		f.Close()
		if parseErr != nil {
			return nil, fmt.Errorf("parse csv: %w", parseErr)
		}
		rows = parsed
		break
	}

	r.attachMemoryResults(rows, builtin, binPath, taskDir)
	return rows, nil
}

// attachMemoryResults runs the Massif-based memory harness for one .bin and
// merges its measurements into the parsed rows.
func (r *BenchmarkRunner) attachMemoryResults(rows []BenchmarkRow, builtin map[string]interface{}, binPath, taskDir string) {
	memBinary, err := r.resolveMemoryBinary()
	if err != nil {
		for i := range rows {
			markMemoryMissing(&rows[i])
		}
		logger.Warn("memory harness unavailable", "error", err)
		return
	}

	massifDir := filepath.Join(taskDir, "massif")
	if err := os.MkdirAll(massifDir, 0755); err != nil {
		for i := range rows {
			markMemoryMissing(&rows[i])
		}
		return
	}
	defer os.RemoveAll(massifDir)

	baselineCache := make(map[string]int64)
	results := make(map[string]*MemoryResult)
	for name, opts := range builtin {
		optMap, _ := opts.(map[string]interface{})
		invocation := mapCompressorName(name, optMap)
		result, err := RunMemoryHarnessWithBaseline(memBinary, invocation, binPath, massifDir, r.cfg.BenchTimeout, baselineCache)
		if err != nil {
			logger.Warn("memory measurement failed", "compressor", invocation, "error", err)
			continue
		}
		base := invocation
		if idx := strings.IndexByte(base, '='); idx >= 0 {
			base = base[:idx]
		}
		results[strings.ToLower(base)] = result
	}

	for i := range rows {
		row := &rows[i]
		result := results[strings.ToLower(row.Compressor)]
		if result == nil {
			markMemoryMissing(row)
			continue
		}
		row.MemoryUsage = result.PeakMemoryBytes
		row.InputBuffer = result.InputBufferBytes
		row.CompressorInternal = result.CompressorInternal
		delete(row.Missing, "memory_usage")
		delete(row.Missing, "input_buffer")
		delete(row.Missing, "compressor_internal")
		if ratio := computeInternalMemoryRatio(result.CompressorInternal, result.InputBufferBytes); ratio != nil {
			row.InternalMemoryRatio = *ratio
			delete(row.Missing, "internal_memory_ratio")
		} else {
			markMissing(row, "internal_memory_ratio")
		}
		if rel := computeRelativeMemoryUsage(result.PeakMemoryBytes, result.InputBufferBytes); rel != nil {
			row.RelativeMemoryUsage = *rel
			delete(row.Missing, "relative_memory_usage")
		} else {
			markMissing(row, "relative_memory_usage")
		}
	}
}

// runCustomTask executes a user-provided compressor package for one .bin.
func (r *BenchmarkRunner) runCustomTask(ctx context.Context, benchmark *model.Benchmark, task *model.BenchmarkTask, binPath, taskDir string) ([]BenchmarkRow, error) {
	if task.Compressor == nil {
		return nil, fmt.Errorf("custom task without compressor")
	}
	name := *task.Compressor

	pkg, err := r.pkgRepo.FindByName(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("load compressor %s: %w", name, err)
	}
	if pkg == nil || pkg.Status != "ready" {
		return nil, fmt.Errorf("compressor %s is not ready", name)
	}
	if pkg.BuiltPath == nil {
		return nil, fmt.Errorf("compressor %s has no build artifact", name)
	}
	if r.container == nil {
		return nil, fmt.Errorf("container runner unavailable")
	}

	var spec compressor.PackageSpec
	if err := json.Unmarshal(pkg.Spec, &spec); err != nil {
		return nil, fmt.Errorf("decode package spec: %w", err)
	}
	provided, _ := benchmark.Compressors[name].(map[string]interface{})
	options := mergeOptions(spec.Options, provided)

	customDir := filepath.Join(taskDir, "custom")
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

	for attempt := 0; attempt <= r.cfg.BenchMaxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Second)
		}

		runCtx, cancel := context.WithTimeout(ctx, r.cfg.BenchTimeout)
		result, runErr := r.container.Run(runCtx, runner.Spec{
			Mounts: []runner.Mount{
				volumeOrBind(r.cfg.CompressorDir, r.cfg.CompressorVolume, true),
				volumeOrBind(r.cfg.DataDir, r.cfg.BenchVolume, false),
			},
			WorkingDir:     filepath.Join(r.cfg.CompressorDir, *pkg.BuiltPath, "pkg"),
			Command:        command,
			Env:            []string{"HOME=/tmp", "TMPDIR=/tmp"},
			User:           "1000",
			Workers:        task.Workers,
			KillOnThrottle: true,
		})
		cancel()

		if runErr != nil {
			if errors.Is(runErr, runner.ErrTimeout) {
				return nil, errTaskTimeout
			}
			if errors.Is(runErr, runner.ErrWorkerQuota) {
				return nil, fmt.Errorf("compressor %s exceeded its declared worker count", name)
			}
			if attempt == r.cfg.BenchMaxRetries {
				return nil, runErr
			}
			continue
		}
		if result.ExitCode != 0 {
			if attempt == r.cfg.BenchMaxRetries {
				return nil, fmt.Errorf("exit code %d: %s", result.ExitCode, truncate(result.Logs, 500))
			}
			continue
		}

		f, err := os.Open(outPath)
		if err != nil {
			return nil, fmt.Errorf("open output csv: %w", err)
		}
		rows, parseErr := ParseCSVLenient(f)
		f.Close()
		if parseErr != nil {
			return nil, fmt.Errorf("parse output csv: %w", parseErr)
		}
		for i := range rows {
			rows[i].Compressor = name
		}
		return rows, nil
	}

	return nil, fmt.Errorf("compressor %s failed", name)
}

func (r *BenchmarkRunner) resolveBinary() (string, error) {
	r.binOnce.Do(func() {
		path := r.cfg.BenchBinaryPath
		if _, err := os.Stat(path); err == nil {
			r.binPath, r.binReady = path, true
			return
		}
		fallback := strings.Replace(path, "LosslessBenchmarkFull", "LosslessBenchmark", 1)
		if _, err := os.Stat(fallback); err == nil {
			r.binPath, r.binReady = fallback, true
		}
	})
	if !r.binReady {
		return "", fmt.Errorf("benchmark binary not found: %s", r.cfg.BenchBinaryPath)
	}
	return r.binPath, nil
}

func (r *BenchmarkRunner) resolveMemoryBinary() (string, error) {
	path := strings.Replace(r.cfg.BenchBinaryPath, "LosslessBenchmarkFull", "MemoryHarness", 1)
	path = strings.Replace(path, "LosslessBenchmark", "MemoryHarness", 1)
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("memory harness binary not found: %s", path)
	}
	return path, nil
}

func rowToResult(benchmarkID uuid.UUID, dataset string, row BenchmarkRow) *model.BenchmarkResult {
	rangeJSON, _ := json.Marshal(row.RangeQueries)
	res := &model.BenchmarkResult{
		BenchmarkID:                benchmarkID,
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
	if !row.Missing["input_buffer"] {
		res.InputBuffer = int64Ptr(row.InputBuffer)
	}
	if !row.Missing["compressor_internal"] {
		res.CompressorInternal = int64Ptr(row.CompressorInternal)
	}
	if !row.Missing["internal_memory_ratio"] {
		res.InternalMemoryRatio = float64Ptr(row.InternalMemoryRatio)
	}
	if !row.Missing["relative_memory_usage"] {
		res.RelativeMemoryUsage = float64Ptr(row.RelativeMemoryUsage)
	}
	if !row.Missing["random_access_ns"] {
		res.RandomAccessNs = float64Ptr(row.RandomAccessNs)
	}
	if !row.Missing["random_access_mbs"] {
		res.RandomAccessMbs = float64Ptr(row.RandomAccessMbs)
	}
	return res
}

func markMemoryMissing(row *BenchmarkRow) {
	markMissing(row, "memory_usage")
	markMissing(row, "input_buffer")
	markMissing(row, "compressor_internal")
	markMissing(row, "internal_memory_ratio")
	markMissing(row, "relative_memory_usage")
}

func markMissing(row *BenchmarkRow, key string) {
	if row.Missing == nil {
		row.Missing = make(map[string]bool)
	}
	row.Missing[key] = true
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
