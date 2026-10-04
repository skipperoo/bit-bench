//go:build integration

package worker

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"bitbench/internal/model"
	"bitbench/internal/repository"
)

func createUserGroup(t *testing.T, ctx context.Context, suffix string, priority int) (uuid.UUID, uuid.UUID) {
	t.Helper()
	var groupID uuid.UUID
	if err := testDB.QueryRow(ctx,
		`INSERT INTO groups (name, priority) VALUES ($1, $2) RETURNING id`,
		"grp-"+suffix, priority).Scan(&groupID); err != nil {
		t.Fatalf("create group: %v", err)
	}
	var userID uuid.UUID
	if err := testDB.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, role, group_id) VALUES ($1, 'x', 'student', $2) RETURNING id`,
		"user-"+suffix+"@test.com", groupID).Scan(&userID); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return userID, groupID
}

func createBenchmarkWithTasks(t *testing.T, ctx context.Context, userID uuid.UUID, name string, costs []int) uuid.UUID {
	t.Helper()
	benchRepo := repository.NewBenchmarkRepository(testDB)
	taskRepo := repository.NewBenchmarkTaskRepository(testDB)

	benchmark := &model.Benchmark{
		UserID:           userID,
		Name:             name,
		OriginalFilename: name + ".bin",
		FileSize:         16,
		FileCount:        1,
		FileChecksum:     "00000000000000000000000000000000",
		FileExt:          ".bin",
		Compressors:      map[string]interface{}{"gzip": map[string]interface{}{}},
	}
	if err := benchRepo.Create(ctx, benchmark); err != nil {
		t.Fatalf("create benchmark: %v", err)
	}

	tasks := make([]*model.BenchmarkTask, 0, len(costs))
	for i, cost := range costs {
		tasks = append(tasks, &model.BenchmarkTask{
			BenchmarkID: benchmark.ID,
			Seq:         i + 1,
			Kind:        model.TaskKindBuiltin,
			InputPath:   benchmark.ID.String() + "/inputs/task.bin",
			Workers:     cost,
		})
	}
	if err := taskRepo.CreateBatch(ctx, tasks); err != nil {
		t.Fatalf("create tasks: %v", err)
	}
	return benchmark.ID
}

func purgeTasks(t *testing.T, ctx context.Context) {
	t.Helper()
	if _, err := testDB.Exec(ctx, `DELETE FROM benchmark_tasks WHERE status IN ('queued', 'running')`); err != nil {
		t.Fatalf("purge tasks: %v", err)
	}
}

func TestClaimNextRespectsPriority(t *testing.T) {
	ctx := context.Background()
	purgeTasks(t, ctx)
	taskRepo := repository.NewBenchmarkTaskRepository(testDB)

	lowUser, _ := createUserGroup(t, ctx, "prio-low", 0)
	highUser, _ := createUserGroup(t, ctx, "prio-high", 100)

	lowID := createBenchmarkWithTasks(t, ctx, lowUser, "low priority", []int{1})
	highID := createBenchmarkWithTasks(t, ctx, highUser, "high priority", []int{1})

	task, err := taskRepo.ClaimNext(ctx, 1)
	if err != nil || task == nil {
		t.Fatalf("claim: task=%v err=%v", task, err)
	}
	if task.BenchmarkID != highID {
		t.Fatalf("claimed benchmark %s, want high-priority %s (low was %s)", task.BenchmarkID, highID, lowID)
	}
}

func TestClaimNextFairShare(t *testing.T) {
	ctx := context.Background()
	purgeTasks(t, ctx)
	taskRepo := repository.NewBenchmarkTaskRepository(testDB)

	userA, _ := createUserGroup(t, ctx, "fair-a", 200)
	userB, _ := createUserGroup(t, ctx, "fair-b", 200)

	// Benchmark A is queued first and has many tasks.
	benchA := createBenchmarkWithTasks(t, ctx, userA, "fair A", []int{1, 1, 1, 1, 1, 1, 1, 1})
	benchB := createBenchmarkWithTasks(t, ctx, userB, "fair B", []int{1, 1, 1, 1})

	first, err := taskRepo.ClaimNext(ctx, 1)
	if err != nil || first == nil {
		t.Fatalf("first claim: %v", err)
	}
	if first.BenchmarkID != benchA {
		t.Fatalf("first claim = %s, want FIFO benchmark A %s", first.BenchmarkID, benchA)
	}

	// A already has one running unit, so the next claim must go to B.
	second, err := taskRepo.ClaimNext(ctx, 1)
	if err != nil || second == nil {
		t.Fatalf("second claim: %v", err)
	}
	if second.BenchmarkID != benchB {
		t.Fatalf("second claim = %s, want fair-share benchmark B %s", second.BenchmarkID, benchB)
	}
}

func TestClaimNextRequiresFittingWorkers(t *testing.T) {
	ctx := context.Background()
	purgeTasks(t, ctx)
	taskRepo := repository.NewBenchmarkTaskRepository(testDB)

	user, _ := createUserGroup(t, ctx, "fit", 300)
	benchID := createBenchmarkWithTasks(t, ctx, user, "big task", []int{4})

	task, err := taskRepo.ClaimNext(ctx, 2)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if task != nil {
		t.Fatalf("claimed a 4-unit task with only 2 free units: %+v", task)
	}

	task, err = taskRepo.ClaimNext(ctx, 4)
	if err != nil || task == nil {
		t.Fatalf("claim with 4 free: task=%v err=%v", task, err)
	}
	if task.BenchmarkID != benchID || task.Workers != 4 {
		t.Fatalf("unexpected task: %+v", task)
	}
}

func TestClaimNextSkipsCancelledBenchmarks(t *testing.T) {
	ctx := context.Background()
	purgeTasks(t, ctx)
	taskRepo := repository.NewBenchmarkTaskRepository(testDB)
	benchRepo := repository.NewBenchmarkRepository(testDB)

	user, _ := createUserGroup(t, ctx, "cancel", 400)
	benchID := createBenchmarkWithTasks(t, ctx, user, "cancelled", []int{1})

	if _, err := benchRepo.Cancel(ctx, benchID, "test cancel"); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	task, err := taskRepo.ClaimNext(ctx, 1)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if task != nil && task.BenchmarkID == benchID {
		t.Fatalf("claimed task of a cancelled benchmark: %+v", task)
	}
}
