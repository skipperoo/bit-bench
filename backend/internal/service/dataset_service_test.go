package service

import (
	"strings"
	"testing"

	"bitbench/internal/dataset"
)

func testDataset() *dataset.Dataset {
	return &dataset.Dataset{Name: "ds", Series: []dataset.Series{
		{Name: "long", Values: 10000},
		{Name: "short", Values: 500},
		{Name: "broken", Error: "invalid"},
	}}
}

func TestPlanDatasetRunsMatrix(t *testing.T) {
	runs, err := planDatasetRuns(testDataset(), &DatasetRunRequest{
		ChunkSizes: []uint64{1000, 0, 1000},
		Transforms: []string{"std", "gap"},
		MaxChunks:  5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 4 {
		t.Fatalf("got %d runs, want 2 transforms x 2 unique sizes", len(runs))
	}
	// Whole series first (sizes are sorted), both usable series, one input each.
	if runs[0].plan.ChunkSize != 0 || runs[0].inputs != 2 {
		t.Errorf("whole-series run = %+v", runs[0])
	}
	// 1000-sample chunks: long -> min(10, 5) inputs, short is repeated to fill one.
	if runs[1].inputs != 6 || len(runs[1].extended) != 1 || runs[1].extended[0] != "short" {
		t.Errorf("chunked run = %+v", runs[1])
	}
	if name := runName("wild", runs[1], true); name != "wild · std · 1000" {
		t.Errorf("run name %q", name)
	}
}

func TestPlanDatasetRunsRejects(t *testing.T) {
	cases := map[string]DatasetRunRequest{
		"no series":       {Series: []string{"missing"}},
		"broken series":   {Series: []string{"broken"}},
		"bad transform":   {Transforms: []string{"zigzag"}},
		"too many runs":   {ChunkSizes: []uint64{2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, Transforms: []string{"std", "gap", "gap_shifted"}},
		"too many inputs": {ChunkSizes: []uint64{2}},
	}
	for name, req := range cases {
		req := req
		if _, err := planDatasetRuns(testDataset(), &req); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestPlanDatasetRunsExtendsEverySeries(t *testing.T) {
	runs, err := planDatasetRuns(testDataset(), &DatasetRunRequest{ChunkSizes: []uint64{20000}})
	if err != nil {
		t.Fatal(err)
	}
	if runs[0].inputs != 2 || len(runs[0].extended) != 2 {
		t.Fatalf("chunk longer than every series = %+v, want both series extended", runs[0])
	}
}

func TestBenchmarkOptionsNormalize(t *testing.T) {
	o := BenchmarkOptions{Aggregation: " Pooled "}
	if err := o.normalize(); err != nil || o.Aggregation != "pooled" {
		t.Fatalf("normalize: %v %q", err, o.Aggregation)
	}
	o = BenchmarkOptions{}
	if err := o.normalize(); err != nil || o.Aggregation != "mean" {
		t.Fatalf("empty aggregation should default to mean")
	}
	o = BenchmarkOptions{Aggregation: "max"}
	if err := o.normalize(); err == nil || !strings.Contains(err.Error(), "aggregation") {
		t.Fatal("unknown aggregation must be rejected")
	}
}
