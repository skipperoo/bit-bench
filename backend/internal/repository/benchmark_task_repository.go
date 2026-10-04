package repository

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/model"
)

type BenchmarkTaskRepository struct {
	db *pgxpool.Pool
}

func NewBenchmarkTaskRepository(db *pgxpool.Pool) *BenchmarkTaskRepository {
	return &BenchmarkTaskRepository{db: db}
}

const taskColumns = `id, benchmark_id, seq, kind, compressor, input_path, workers, status, result, error, started_at, finished_at, created_at`

func scanTask(row pgx.Row) (*model.BenchmarkTask, error) {
	t := &model.BenchmarkTask{}
	err := row.Scan(
		&t.ID, &t.BenchmarkID, &t.Seq, &t.Kind, &t.Compressor, &t.InputPath,
		&t.Workers, &t.Status, &t.Result, &t.Error, &t.StartedAt, &t.FinishedAt, &t.CreatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return t, nil
}

// CreateBatch inserts all tasks of one benchmark.
func (r *BenchmarkTaskRepository) CreateBatch(ctx context.Context, tasks []*model.BenchmarkTask) error {
	if len(tasks) == 0 {
		return fmt.Errorf("no tasks to insert")
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	batch := &pgx.Batch{}
	for _, t := range tasks {
		if t.ID == uuid.Nil {
			t.ID = uuid.New()
		}
		if t.Status == "" {
			t.Status = model.TaskQueued
		}
		if t.Workers < 1 {
			t.Workers = 1
		}
		batch.Queue(`
			INSERT INTO benchmark_tasks
				(id, benchmark_id, seq, kind, compressor, input_path, workers, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`, t.ID, t.BenchmarkID, t.Seq, t.Kind, t.Compressor, t.InputPath, t.Workers, t.Status)
	}

	results := tx.SendBatch(ctx, batch)
	for range tasks {
		if _, err := results.Exec(); err != nil {
			results.Close()
			return err
		}
	}
	if err := results.Close(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ClaimNext marks and returns the best queued task that fits in freeWorkers.
// Claim order: group priority DESC, running worker units per benchmark ASC
// (fair share), then queue order.
func (r *BenchmarkTaskRepository) ClaimNext(ctx context.Context, freeWorkers int) (*model.BenchmarkTask, error) {
	if freeWorkers < 1 {
		return nil, nil
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Pick the best candidate without locking, then lock the benchmark row
	// before the task row. finalize() takes the same lock order, which avoids
	// deadlocks between claiming and aggregation.
	task := &model.BenchmarkTask{}
	err = tx.QueryRow(ctx, `
		SELECT t.id, t.benchmark_id, t.seq, t.kind, t.compressor, t.input_path, t.workers
		FROM benchmark_tasks t
		JOIN benchmarks b ON b.id = t.benchmark_id
		LEFT JOIN users u ON u.id = b.user_id
		LEFT JOIN groups g ON g.id = u.group_id
		WHERE t.status = 'queued'
		  AND b.status IN ('queued', 'in_progress')
		  AND t.workers <= $1
		ORDER BY COALESCE(g.priority, 0) DESC,
		         (SELECT COALESCE(SUM(r.workers), 0) FROM benchmark_tasks r
		          WHERE r.benchmark_id = t.benchmark_id AND r.status = 'running') ASC,
		         t.created_at ASC, t.seq ASC
		LIMIT 1
	`, freeWorkers).Scan(
		&task.ID, &task.BenchmarkID, &task.Seq, &task.Kind, &task.Compressor,
		&task.InputPath, &task.Workers,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var benchStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM benchmarks WHERE id = $1 FOR UPDATE`, task.BenchmarkID).Scan(&benchStatus)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if benchStatus != "queued" && benchStatus != "in_progress" {
		return nil, nil
	}

	tag, err := tx.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'running', started_at = NOW()
		WHERE id = $1 AND status = 'queued'
	`, task.ID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}

	if _, err := tx.Exec(ctx, `
		UPDATE benchmarks SET status = 'in_progress', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
		WHERE id = $1 AND status = 'queued'
	`, task.BenchmarkID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return task, nil
}

func (r *BenchmarkTaskRepository) Complete(ctx context.Context, id uuid.UUID, result []byte) error {
	_, err := r.db.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'done', result = $2, error = NULL, finished_at = NOW()
		WHERE id = $1
	`, id, result)
	return err
}

func (r *BenchmarkTaskRepository) Fail(ctx context.Context, id uuid.UUID, errMsg string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'failed', error = $2, finished_at = NOW()
		WHERE id = $1
	`, id, errMsg)
	return err
}

// Cancel marks a running or queued task cancelled (used when the benchmark is
// cancelled or another task has already failed).
func (r *BenchmarkTaskRepository) Cancel(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'cancelled', finished_at = NOW()
		WHERE id = $1 AND status IN ('queued', 'running')
	`, id)
	return err
}

// CancelQueuedForBenchmark cancels every queued task of a benchmark.
func (r *BenchmarkTaskRepository) CancelQueuedForBenchmark(ctx context.Context, benchmarkID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'cancelled', finished_at = NOW()
		WHERE benchmark_id = $1 AND status = 'queued'
	`, benchmarkID)
	return err
}

// ResetRunning re-queues tasks left running by a crash (startup recovery).
func (r *BenchmarkTaskRepository) ResetRunning(ctx context.Context) (int64, error) {
	tag, err := r.db.Exec(ctx, `
		UPDATE benchmark_tasks SET status = 'queued', started_at = NULL
		WHERE status = 'running'
	`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

type TaskCounts struct {
	Queued    int
	Running   int
	Done      int
	Failed    int
	Cancelled int
}

func (c TaskCounts) Terminal() int { return c.Done + c.Failed + c.Cancelled }
func (c TaskCounts) Pending() int  { return c.Queued + c.Running }
func (c TaskCounts) Total() int    { return c.Terminal() + c.Pending() }

func (r *BenchmarkTaskRepository) Counts(ctx context.Context, benchmarkID uuid.UUID) (*TaskCounts, error) {
	counts := &TaskCounts{}
	err := r.db.QueryRow(ctx, `
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

// DoneResults returns the result payloads of all completed tasks.
func (r *BenchmarkTaskRepository) DoneResults(ctx context.Context, benchmarkID uuid.UUID) ([][]byte, error) {
	rows, err := r.db.Query(ctx, `
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

// ListByBenchmark returns all tasks of a benchmark in order.
func (r *BenchmarkTaskRepository) ListByBenchmark(ctx context.Context, benchmarkID uuid.UUID) ([]*model.BenchmarkTask, error) {
	rows, err := r.db.Query(ctx, `SELECT `+taskColumns+` FROM benchmark_tasks WHERE benchmark_id = $1 ORDER BY seq ASC`, benchmarkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*model.BenchmarkTask
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

func (r *BenchmarkTaskRepository) DeleteByBenchmark(ctx context.Context, benchmarkID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM benchmark_tasks WHERE benchmark_id = $1`, benchmarkID)
	return err
}
