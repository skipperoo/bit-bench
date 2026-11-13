//go:build integration

package worker

import (
	"context"
	"encoding/json"
	"testing"

	"bitbench/internal/config"
	"bitbench/internal/repository"
)

// TestFinalizeStoresPerSeriesResults finalizes a dataset benchmark whose
// inputs come from two series and checks the overall and per-series rows.
func TestFinalizeStoresPerSeriesResults(t *testing.T) {
	ctx := context.Background()
	userID, _ := createUserGroup(t, ctx, "series", 0)
	id := createBenchmarkWithTasks(t, ctx, userID, "series", []int{1, 1, 1})
	if _, err := testDB.Exec(ctx, `UPDATE benchmarks SET file_ext = 'dataset', status = 'in_progress' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	// Series "acc_x" has two chunks (ratios 0.2 and 0.4), "ppg" one (0.9).
	inputs := map[int]struct {
		path  string
		ratio float64
	}{1: {"inputs/00/acc_x_0.bin", 0.2}, 2: {"inputs/00/acc_x_7.bin", 0.4}, 3: {"inputs/01/ppg_0.bin", 0.9}}
	for seq, in := range inputs {
		rows, _ := json.Marshal([]BenchmarkRow{{Compressor: "gzip", NumValues: 10, CompressionRatio: in.ratio}})
		if _, err := testDB.Exec(ctx, `UPDATE benchmark_tasks SET status = 'done', input_path = $3, result = $4 WHERE benchmark_id = $1 AND seq = $2`,
			id, seq, id.String()+"/"+in.path, rows); err != nil {
			t.Fatal(err)
		}
	}

	runner := NewBenchmarkRunner(&config.Config{DataDir: t.TempDir(), MaxParallelism: 1}, testDB)
	runner.finalize(ctx, id)

	resultRepo := repository.NewBenchmarkResultRepository(testDB)
	overall, err := resultRepo.FindByBenchmarkID(ctx, id)
	if err != nil || len(overall) != 1 || *overall[0].CompressionRatio != 0.5 {
		t.Fatalf("overall = %+v, %v (want the mean over all three inputs, 0.5)", overall, err)
	}
	series, err := resultRepo.FindSeriesByBenchmarkID(ctx, id)
	if err != nil || len(series) != 2 {
		t.Fatalf("series = %+v, %v", series, err)
	}
	want := map[string]float64{"acc_x": 0.30000000000000004, "ppg": 0.9}
	for _, s := range series {
		if len(s.Results) != 1 || s.Results[0].Compressor != "gzip" || *s.Results[0].CompressionRatio != want[s.Series] || s.Results[0].Dataset != s.Series {
			t.Errorf("series %s = %+v", s.Series, s.Results)
		}
	}
	var status string
	testDB.QueryRow(ctx, `SELECT status FROM benchmarks WHERE id = $1`, id).Scan(&status)
	if status != "ready" {
		t.Errorf("status = %s", status)
	}
}
