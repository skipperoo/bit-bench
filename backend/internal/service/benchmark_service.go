package service

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"bitbench/internal/config"
	"bitbench/internal/model"
	"bitbench/internal/repository"
)

var nonAlphaNum = regexp.MustCompile(`[^a-zA-Z0-9]+`)

type BenchmarkService struct {
	benchRepo *repository.BenchmarkRepository
	resultRepo *repository.BenchmarkResultRepository
	cfg        *config.Config
}

func NewBenchmarkService(br *repository.BenchmarkRepository, rr *repository.BenchmarkResultRepository, cfg *config.Config) *BenchmarkService {
	return &BenchmarkService{benchRepo: br, resultRepo: rr, cfg: cfg}
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

// storedFilename returns the on-disk filename per §4.5 "Filename-escaping rule".
func storedFilename(originalName, md5Hex string) string {
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

func (s *BenchmarkService) CreateBenchmark(ctx context.Context, userID uuid.UUID, name string, file io.ReadSeeker, originalFilename string, compressors map[string]interface{}) (*model.Benchmark, error) {
	ext := strings.ToLower(filepath.Ext(originalFilename))
	if !ValidateFileExt(ext) {
		return nil, fmt.Errorf("unsupported file extension: %s", ext)
	}

	// Compute checksum
	checksum, err := fileChecksum(file)
	if err != nil {
		return nil, fmt.Errorf("checksum: %w", err)
	}
	file.Seek(0, 0)

	// Check duplicate
	existing, _ := s.benchRepo.FindByChecksum(ctx, checksum)
	if existing != nil {
		return nil, fmt.Errorf("file already processed (checksum: %s)", checksum)
	}

	// Check size
	fileSize := int64(0)
	if f, ok := file.(*os.File); ok {
		info, _ := f.Stat()
		fileSize = info.Size()
	} else {
		// Read the file to determine size
		data, _ := io.ReadAll(file)
		fileSize = int64(len(data))
		file.Seek(0, 0)
	}
	if s.cfg.MaxFileSizeMB > 0 && fileSize > s.cfg.MaxFileSizeMB*1024*1024 {
		return nil, fmt.Errorf("file exceeds max size of %d MB", s.cfg.MaxFileSizeMB)
	}

	// Write file to DATA_DIR
	storedName := storedFilename(originalFilename, checksum)
	destPath := filepath.Join(s.cfg.DataDir, storedName)
	if err := os.MkdirAll(s.cfg.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dst, err := os.Create(destPath)
	if err != nil {
		return nil, fmt.Errorf("create file: %w", err)
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		return nil, fmt.Errorf("write file: %w", err)
	}

	benchmark := &model.Benchmark{
		UserID:           userID,
		Name:             name,
		OriginalFilename: originalFilename,
		FileSize:         fileSize,
		FileChecksum:     checksum,
		FileExt:          ext,
		Compressors:      compressors,
	}

	if err := s.benchRepo.Create(ctx, benchmark); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("create benchmark: %w", err)
	}

	return benchmark, nil
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
	stats, err := s.benchRepo.GetStatusStats(ctx)
	if err != nil {
		return nil, err
	}

	return &model.StatusResponse{
		QueueDepth: stats.Queued,
		Runner: model.RunnerStatus{
			Running:         0, // updated by worker
			MaxParallelism:  s.cfg.MaxParallelism,
		},
		Stats: *stats,
	}, nil
}
