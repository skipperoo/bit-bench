package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/compressor"
	"bitbench/internal/model"
)

type BenchmarkRepository struct {
	db *pgxpool.Pool
}

func NewBenchmarkRepository(db *pgxpool.Pool) *BenchmarkRepository {
	return &BenchmarkRepository{db: db}
}

func (r *BenchmarkRepository) Create(ctx context.Context, b *model.Benchmark) error {
	compressorsJSON, err := compressor.MarshalInstances(b.Compressors)
	if err != nil {
		return err
	}
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	if b.ExperimentID == uuid.Nil {
		b.ExperimentID = b.ID
	}
	if b.FileCount < 1 {
		b.FileCount = 1
	}
	b.Status = "queued"
	b.CreatedAt = time.Now()
	b.UpdatedAt = time.Now()

	if b.Aggregation == "" {
		b.Aggregation = "mean"
	}
	var sourceJSON []byte
	if b.Source != nil {
		if sourceJSON, err = json.Marshal(b.Source); err != nil {
			return err
		}
	}
	if b.Warnings == nil {
		b.Warnings = []string{}
	}

	_, err = r.db.Exec(ctx, `
		INSERT INTO benchmarks (id, experiment_id, user_id, name, original_filename, file_size, file_count, file_checksum, file_ext, status, compressors,
		                        aggregation, measure_memory, source, warnings)
		VALUES ($1, $15, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
	`, b.ID, b.UserID, b.Name, b.OriginalFilename, b.FileSize, b.FileCount, b.FileChecksum, b.FileExt, b.Status, compressorsJSON,
		b.Aggregation, b.MeasureMemory, sourceJSON, b.Warnings, b.ExperimentID)
	return err
}

func (r *BenchmarkRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.Benchmark, error) {
	b := &model.Benchmark{}
	var compressorsJSON, sourceJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT id, experiment_id, user_id, name, original_filename, file_size, file_count, file_checksum, file_ext, status, compressors, error, warnings,
		       aggregation, measure_memory, source, progress, created_at, started_at, finished_at, updated_at
		FROM benchmarks WHERE id = $1
	`, id).Scan(
		&b.ID, &b.ExperimentID, &b.UserID, &b.Name, &b.OriginalFilename, &b.FileSize, &b.FileCount, &b.FileChecksum,
		&b.FileExt, &b.Status, &compressorsJSON, &b.Error, &b.Warnings,
		&b.Aggregation, &b.MeasureMemory, &sourceJSON, &b.Progress,
		&b.CreatedAt, &b.StartedAt, &b.FinishedAt, &b.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	instances, err := compressor.ParseInstances(compressorsJSON)
	if err != nil {
		return nil, err
	}
	b.Compressors = instances
	if err := decodeSource(b, sourceJSON); err != nil {
		return nil, err
	}
	return b, nil
}

// decodeSource fills b.Source from the source JSONB column (NULL for uploads).
func decodeSource(b *model.Benchmark, raw []byte) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var src model.DatasetSource
	if err := json.Unmarshal(raw, &src); err != nil {
		return fmt.Errorf("decode benchmark source: %w", err)
	}
	b.Source = &src
	return nil
}

type ListBenchmarksParams struct {
	UserID *uuid.UUID
	Cursor *time.Time
	Search string
	// Status filters by one or more comma-separated statuses.
	Status string
	// Source is "upload" or "dataset".
	Source string
	// Dataset filters dataset runs by dataset name.
	Dataset string
	// Compressor keeps benchmarks configuring this compressor name.
	Compressor string
	Limit      int
}

type ListBenchmarksResult struct {
	Benchmarks []*model.Benchmark
	NextCursor *time.Time
}

func (r *BenchmarkRepository) List(ctx context.Context, p ListBenchmarksParams) (*ListBenchmarksResult, error) {
	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 20
	}

	query := `SELECT id, experiment_id, user_id, name, original_filename, file_size, file_count, file_checksum, file_ext, status, compressors, error, warnings,
	                  aggregation, measure_memory, source, progress, created_at, started_at, finished_at, updated_at
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
		query += fmt.Sprintf(` AND status = ANY($%d)`, argIdx)
		args = append(args, strings.Split(p.Status, ","))
		argIdx++
	}
	switch p.Source {
	case "upload":
		query += ` AND source IS NULL`
	case "dataset":
		query += ` AND source IS NOT NULL`
	}
	if p.Dataset != "" {
		query += fmt.Sprintf(` AND source->>'dataset' = $%d`, argIdx)
		args = append(args, p.Dataset)
		argIdx++
	}
	if p.Compressor != "" {
		query += fmt.Sprintf(` AND compressors @> $%d::jsonb`, argIdx)
		filter, _ := json.Marshal([]map[string]string{{"name": strings.ToLower(p.Compressor)}})
		args = append(args, string(filter))
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
		var compressorsJSON, sourceJSON []byte
		err := rows.Scan(
			&b.ID, &b.ExperimentID, &b.UserID, &b.Name, &b.OriginalFilename, &b.FileSize, &b.FileCount, &b.FileChecksum,
			&b.FileExt, &b.Status, &compressorsJSON, &b.Error, &b.Warnings,
			&b.Aggregation, &b.MeasureMemory, &sourceJSON, &b.Progress,
			&b.CreatedAt, &b.StartedAt, &b.FinishedAt, &b.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		instances, err := compressor.ParseInstances(compressorsJSON)
		if err != nil {
			return nil, err
		}
		b.Compressors = instances
		if err := decodeSource(b, sourceJSON); err != nil {
			return nil, err
		}
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

// UpdateStatusIfActive is UpdateStatus restricted to queued/in_progress
// benchmarks, so a late task failure cannot overwrite a cancellation.
func (r *BenchmarkRepository) UpdateStatusIfActive(ctx context.Context, id uuid.UUID, status string, errMsg *string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE benchmarks SET status = $2, error = COALESCE($3, error), finished_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND status IN ('queued', 'in_progress')
	`, id, status, errMsg)
	return err
}

func (r *BenchmarkRepository) UpdateProgress(ctx context.Context, id uuid.UUID, progress int) error {
	_, err := r.db.Exec(ctx, "UPDATE benchmarks SET progress = $1, updated_at = NOW() WHERE id = $2", progress, id)
	return err
}

// UpdateProgressFromTasks derives progress from terminal task counts.
func (r *BenchmarkRepository) UpdateProgressFromTasks(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE benchmarks SET progress = COALESCE((
			SELECT (COUNT(*) FILTER (WHERE status IN ('done','failed','cancelled')) * 100) / NULLIF(COUNT(*), 0)
			FROM benchmark_tasks WHERE benchmark_id = $1
		), 0), updated_at = NOW()
		WHERE id = $1
	`, id)
	return err
}

// Cancel marks a queued/in_progress benchmark and its queued tasks cancelled.
// Running tasks finish normally and their results are discarded.
func (r *BenchmarkRepository) Cancel(ctx context.Context, id uuid.UUID, errMsg string) (bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE benchmarks SET status = 'cancelled', error = $2, finished_at = NOW(), progress = 100, updated_at = NOW()
		WHERE id = $1 AND status IN ('queued', 'in_progress')
	`, id, errMsg)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}

	if _, err := tx.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'cancelled', finished_at = NOW()
		WHERE benchmark_id = $1 AND status = 'queued'
	`, id); err != nil {
		return false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ListStrandedInProgress returns in_progress benchmarks whose tasks are all
// terminal (e.g. after a backend crash during aggregation).
func (r *BenchmarkRepository) ListStrandedInProgress(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `
		SELECT b.id FROM benchmarks b
		WHERE b.status = 'in_progress'
		  AND NOT EXISTS (
		      SELECT 1 FROM benchmark_tasks t
		      WHERE t.benchmark_id = b.id AND t.status IN ('queued', 'running')
		  )
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
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
