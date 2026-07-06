package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/model"
)

type BenchmarkRepository struct {
	db *pgxpool.Pool
}

func NewBenchmarkRepository(db *pgxpool.Pool) *BenchmarkRepository {
	return &BenchmarkRepository{db: db}
}

func (r *BenchmarkRepository) Create(ctx context.Context, b *model.Benchmark) error {
	compressorsJSON, err := json.Marshal(b.Compressors)
	if err != nil {
		return err
	}
	b.ID = uuid.New()
	b.Status = "queued"
	b.CreatedAt = time.Now()
	b.UpdatedAt = time.Now()

	_, err = r.db.Exec(ctx, `
		INSERT INTO benchmarks (id, user_id, name, original_filename, file_size, file_checksum, file_ext, status, compressors)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, b.ID, b.UserID, b.Name, b.OriginalFilename, b.FileSize, b.FileChecksum, b.FileExt, b.Status, compressorsJSON)
	return err
}

func (r *BenchmarkRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.Benchmark, error) {
	b := &model.Benchmark{}
	var compressorsJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT id, user_id, name, original_filename, file_size, file_checksum, file_ext, status, compressors, error,
		       progress, created_at, started_at, finished_at, updated_at
		FROM benchmarks WHERE id = $1
	`, id	).Scan(
		&b.ID, &b.UserID, &b.Name, &b.OriginalFilename, &b.FileSize, &b.FileChecksum,
		&b.FileExt, &b.Status, &compressorsJSON, &b.Error,
		&b.Progress,
		&b.CreatedAt, &b.StartedAt, &b.FinishedAt, &b.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	json.Unmarshal(compressorsJSON, &b.Compressors)
	return b, nil
}

func (r *BenchmarkRepository) FindByChecksum(ctx context.Context, checksum string) (*model.Benchmark, error) {
	b := &model.Benchmark{}
	err := r.db.QueryRow(ctx, `
		SELECT id FROM benchmarks WHERE file_checksum = $1 LIMIT 1
	`, checksum).Scan(&b.ID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return b, nil
}

type ListBenchmarksParams struct {
	UserID *uuid.UUID
	Cursor *time.Time
	Search string
	Status string
	Limit  int
}

type ListBenchmarksResult struct {
	Benchmarks []*model.Benchmark
	NextCursor *time.Time
}

func (r *BenchmarkRepository) List(ctx context.Context, p ListBenchmarksParams) (*ListBenchmarksResult, error) {
	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 20
	}

	query := `SELECT id, user_id, name, original_filename, file_size, file_checksum, file_ext, status, compressors, error,
	                  progress, created_at, started_at, finished_at, updated_at
	           FROM benchmarks WHERE 1=1`
	args := []any{}
	argIdx := 1

	if p.UserID != nil {
		query += fmt.Sprintf(` AND user_id = $%d`, argIdx)
		args = append(args, *p.UserID)
		argIdx++
	}
	if p.Cursor != nil {
		query += fmt.Sprintf(` AND created_at < $%d`, argIdx)
		args = append(args, *p.Cursor)
		argIdx++
	}
	if p.Search != "" {
		query += fmt.Sprintf(` AND name ILIKE $%d`, argIdx)
		args = append(args, "%"+p.Search+"%")
		argIdx++
	}
	if p.Status != "" {
		query += fmt.Sprintf(` AND status = $%d`, argIdx)
		args = append(args, p.Status)
		argIdx++
	}

	query += fmt.Sprintf(` ORDER BY created_at DESC LIMIT $%d`, argIdx)
	args = append(args, p.Limit+1)

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &ListBenchmarksResult{}
	var count int
	for rows.Next() {
		count++
		if count > p.Limit {
			continue
		}
		b := &model.Benchmark{}
		var compressorsJSON []byte
		err := rows.Scan(
			&b.ID, &b.UserID, &b.Name, &b.OriginalFilename, &b.FileSize, &b.FileChecksum,
			&b.FileExt, &b.Status, &compressorsJSON, &b.Error,
			&b.Progress,
			&b.CreatedAt, &b.StartedAt, &b.FinishedAt, &b.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		json.Unmarshal(compressorsJSON, &b.Compressors)
		result.Benchmarks = append(result.Benchmarks, b)
	}

	if count > p.Limit && len(result.Benchmarks) > 0 {
		last := result.Benchmarks[len(result.Benchmarks)-1]
		result.NextCursor = &last.CreatedAt
	}

	return result, nil
}

func (r *BenchmarkRepository) UpdateStatus(ctx context.Context, id uuid.UUID, status string, errMsg *string) error {
	query := `UPDATE benchmarks SET status = $1, updated_at = NOW()`
	args := []any{status, id}
	argIdx := 3

	if status == "in_progress" {
		query += `, started_at = COALESCE(started_at, NOW())`
	}
	if status == "ready" || status == "failed" || status == "timed_out" || status == "cancelled" {
		query += `, finished_at = NOW()`
	}
	if status == "ready" {
		query += `, progress = 100`
	}
	if errMsg != nil {
		query += fmt.Sprintf(`, error = $%d`, argIdx)
		args = append(args, *errMsg)
		argIdx++
	}

	query += ` WHERE id = $2`
	_, err := r.db.Exec(ctx, query, args...)
	return err
}

func (r *BenchmarkRepository) UpdateProgress(ctx context.Context, id uuid.UUID, progress int) error {
	_, err := r.db.Exec(ctx, "UPDATE benchmarks SET progress = $1, updated_at = NOW() WHERE id = $2", progress, id)
	return err
}

func (r *BenchmarkRepository) ListChecksums(ctx context.Context) ([]string, error) {
	rows, err := r.db.Query(ctx, "SELECT file_checksum FROM benchmarks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var checksums []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		checksums = append(checksums, c)
	}
	return checksums, nil
}

func (r *BenchmarkRepository) GetStatusStats(ctx context.Context) (*model.StatusStats, error) {
	stats := &model.StatusStats{}
	rows, err := r.db.Query(ctx, "SELECT status, COUNT(*) FROM benchmarks GROUP BY status")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		switch status {
		case "queued":
			stats.Queued = count
		case "in_progress":
			stats.InProgress = count
		case "ready":
			stats.Ready = count
		case "failed":
			stats.Failed = count
		case "timed_out":
			stats.TimedOut = count
		case "cancelled":
			stats.Cancelled = count
		}
	}
	return stats, nil
}

func (r *BenchmarkRepository) GetUserStatusStats(ctx context.Context, userID uuid.UUID) (*model.StatusStats, error) {
	stats := &model.StatusStats{}
	rows, err := r.db.Query(ctx, "SELECT status, COUNT(*) FROM benchmarks WHERE user_id = $1 GROUP BY status", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		switch status {
		case "queued":
			stats.Queued = count
		case "in_progress":
			stats.InProgress = count
		case "ready":
			stats.Ready = count
		case "failed":
			stats.Failed = count
		case "timed_out":
			stats.TimedOut = count
		case "cancelled":
			stats.Cancelled = count
		}
	}
	return stats, nil
}

func (r *BenchmarkRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, "DELETE FROM benchmarks WHERE id = $1", id)
	return err
}
