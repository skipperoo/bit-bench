package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"bitbench/internal/config"
	"bitbench/internal/logger"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/service"
)

type BenchmarkRunner struct {
	cfg       *config.Config
	db        *pgxpool.Pool
	rdb       *redis.Client
	benchRepo *repository.BenchmarkRepository
	resultRepo *repository.BenchmarkResultRepository
	running   atomic.Int32
}

func NewBenchmarkRunner(cfg *config.Config, db *pgxpool.Pool, rdb *redis.Client) *BenchmarkRunner {
	return &BenchmarkRunner{
		cfg:        cfg,
		db:         db,
		rdb:        rdb,
		benchRepo:  repository.NewBenchmarkRepository(db),
		resultRepo: repository.NewBenchmarkResultRepository(db),
	}
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

	// Mark progress as started (5% — loading + normalization)
	r.updateProgress(ctx, id, 5)

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

	compressorList := BuildCompressorList(benchmark.Compressors)
	if compressorList == "" {
		r.failJob(ctx, id, "no compressors selected", workDir)
		return
	}

	// Find the benchmark binary path
	binaryPath := r.cfg.BenchBinaryPath
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

	// Progress: files ready, about to run benchmark
	r.updateProgress(ctx, id, 10)

	// Run benchmark for each .bin file
	var allRows []BenchmarkRow
	var lastErr string

	r.updateProgress(ctx, id, 15)

	for attempt := 0; attempt <= r.cfg.BenchMaxRetries; attempt++ {
		if attempt > 0 {
			logger.Info("retrying benchmark", "id", id, "attempt", attempt)
			time.Sleep(1 * time.Second)
		}

		allRows = nil
		var hadError bool

		for _, binPath := range binPaths {
			result, err := RunBenchmark(binaryPath, compressorList, binPath, workDir, r.cfg.BenchTimeout)
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

	// Average rows per compressor
	averaged := AverageRows(allRows)

	// Get original compressor names for MemoryHarness (lowercase)
	originalCompNames := make([]string, 0, len(benchmark.Compressors))
	for name, opts := range benchmark.Compressors {
		optMap, _ := opts.(map[string]interface{})
		baseName := mapCompressorName(name, optMap)
		originalCompNames = append(originalCompNames, baseName)
	}

	// Mark progress: performance benchmark done
	r.updateProgress(ctx, id, 40)

	// Progress: about to start memory measurements
	r.updateProgress(ctx, id, 45)

	// Run memory measurements (Valgrind Massif-based)
	memoryResults := r.runMemoryMeasurements(ctx, id, binaryPath, originalCompNames, binPaths, workDir)

	// Progress: memory done, inserting results
	r.updateProgress(ctx, id, 95)

	// Insert results
	var lastInsertErr error
	dataset := strings.TrimSuffix(benchmark.OriginalFilename, "."+benchmark.FileExt)
	for _, row := range averaged {
		rangeJSON, _ := json.Marshal(row.RangeQueries)

		res := &model.BenchmarkResult{
			BenchmarkID:               id,
			Compressor:                row.Compressor,
			Dataset:                   dataset,
			NumValues:                 int64Ptr(row.NumValues),
			OriginalSize:              int64Ptr(row.OriginalSize),
			MemoryUsage:               int64Ptr(row.MemoryUsage),
			UncompressedBits:          int64Ptr(row.UncompressedBits),
			CompressedBits:            int64Ptr(row.CompressedBits),
			CompressionRatio:          float64Ptr(row.CompressionRatio),
			CompressionThroughputMbs:  float64Ptr(row.CompressionThroughputMbs),
			DecompressionThroughputMbs: float64Ptr(row.DecompressionThroughputMbs),
			RandomAccessNs:            float64Ptr(row.RandomAccessNs),
			RandomAccessMbs:           float64Ptr(row.RandomAccessMbs),
			RangeQueries:              rangeJSON,
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

		// Update progress: memory portion is the second 50%
		pct := 50 + (i+1)*50/numComps
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
