package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"

	"bitbench/internal/dataset"
	"bitbench/internal/model"
)

// MaxDatasetRuns caps how many benchmarks one dataset request may create
// (chunk sizes x transforms).
const MaxDatasetRuns = 32

// DatasetRunRequest asks for benchmarks over a standardized dataset. Every
// (chunk size, transform) combination becomes one benchmark, like one
// datasets/<transform>/size_<N> folder of run_all_benchmarks.sh.
type DatasetRunRequest struct {
	Name    string   `json:"name"`
	Dataset string   `json:"dataset"`
	Series  []string `json:"series"` // empty = every valid series
	// ChunkSizes in samples; 0 benchmarks each whole series as one input.
	ChunkSizes []uint64 `json:"chunk_sizes"`
	// MaxChunks keeps at most this many evenly spaced chunks per series
	// (0 = all).
	MaxChunks     int             `json:"max_chunks"`
	Transforms    []string        `json:"transforms"` // std, gap, gap_shifted
	Aggregation   string          `json:"aggregation"`
	MeasureMemory *bool           `json:"measure_memory"`
	Compressors   json.RawMessage `json:"compressors"`
}

// ListDatasets returns the standardized datasets mounted at DATASET_DIR.
func (s *BenchmarkService) ListDatasets() ([]dataset.Dataset, error) {
	return dataset.Scan(s.cfg.DatasetDir)
}

type datasetRun struct {
	plan   dataset.ChunkPlan
	series []string
	inputs int
	// skipped lists series too short for one chunk of this size.
	skipped []string
}

// planDatasetRuns validates a request and expands it into one run per
// (chunk size, transform) combination, without touching the disk.
func planDatasetRuns(ds *dataset.Dataset, req *DatasetRunRequest) ([]datasetRun, error) {
	if req.MaxChunks < 0 || req.MaxChunks > dataset.MaxChunksPerSeries {
		return nil, fmt.Errorf("max_chunks must be between 0 (all) and %d", dataset.MaxChunksPerSeries)
	}

	// Series: the requested ones (validated) or every valid series.
	var series []*dataset.Series
	if len(req.Series) == 0 {
		for i := range ds.Series {
			if ds.Series[i].Error == "" {
				series = append(series, &ds.Series[i])
			}
		}
	} else {
		seen := map[string]bool{}
		for _, name := range req.Series {
			if seen[name] {
				continue
			}
			seen[name] = true
			s, ok := ds.Find(name)
			if !ok {
				return nil, fmt.Errorf("dataset %s has no series %q", ds.Name, name)
			}
			if s.Error != "" {
				return nil, fmt.Errorf("series %s/%s is not usable: %s", ds.Name, name, s.Error)
			}
			series = append(series, s)
		}
	}
	if len(series) == 0 {
		return nil, fmt.Errorf("dataset %s has no usable series", ds.Name)
	}

	chunkSizes := uniqueUints(req.ChunkSizes)
	if len(chunkSizes) == 0 {
		chunkSizes = []uint64{0}
	}
	transforms := uniqueStrings(req.Transforms)
	if len(transforms) == 0 {
		transforms = []string{dataset.TransformStd}
	}
	if len(chunkSizes)*len(transforms) > MaxDatasetRuns {
		return nil, fmt.Errorf("%d chunk sizes x %d transforms is more than %d benchmarks", len(chunkSizes), len(transforms), MaxDatasetRuns)
	}

	var runs []datasetRun
	for _, transform := range transforms {
		for _, size := range chunkSizes {
			run := datasetRun{plan: dataset.ChunkPlan{ChunkSize: size, MaxChunks: req.MaxChunks, Transform: transform}}
			if err := run.plan.Validate(); err != nil {
				return nil, err
			}
			for _, s := range series {
				n := dataset.PlannedChunks(s.Values, run.plan)
				if n == 0 {
					run.skipped = append(run.skipped, s.Name)
					continue
				}
				run.series = append(run.series, s.Name)
				run.inputs += n
			}
			if run.inputs == 0 {
				return nil, fmt.Errorf("chunk size %d is longer than every selected series", size)
			}
			if run.inputs > dataset.MaxInputsPerRun {
				return nil, fmt.Errorf("chunk size %d yields %d inputs (max %d); set max chunks per series", size, run.inputs, dataset.MaxInputsPerRun)
			}
			runs = append(runs, run)
		}
	}
	return runs, nil
}

// runName labels one combination: "<name> · <transform> · <chunk>".
func runName(base string, run datasetRun, multiple bool) string {
	if !multiple {
		return base
	}
	chunk := "whole"
	if run.plan.ChunkSize > 0 {
		chunk = fmt.Sprintf("%d", run.plan.ChunkSize)
	}
	return fmt.Sprintf("%s · %s · %s", base, run.plan.Transform, chunk)
}

// CreateDatasetBenchmarks cuts the requested series into .bin inputs and
// enqueues one benchmark per (chunk size, transform) combination.
func (s *BenchmarkService) CreateDatasetBenchmarks(ctx context.Context, actor *model.User, req DatasetRunRequest) ([]*model.Benchmark, error) {
	if actor == nil {
		return nil, fmt.Errorf("unauthorized")
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = req.Dataset
	}
	opts := BenchmarkOptions{Aggregation: req.Aggregation, MeasureMemory: true}
	if req.MeasureMemory != nil {
		opts.MeasureMemory = *req.MeasureMemory
	}
	if err := opts.normalize(); err != nil {
		return nil, err
	}
	if len(req.Compressors) == 0 {
		return nil, fmt.Errorf("compressors are required")
	}

	ds, err := dataset.Load(s.cfg.DatasetDir, req.Dataset)
	if err != nil {
		return nil, err
	}
	runs, err := planDatasetRuns(ds, &req)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveInstances(ctx, s.pkgRepo, s.cfg.MaxParallelism, s.cfg.HostPlatform, actor, req.Compressors)
	if err != nil {
		return nil, err
	}

	opts.ExperimentID = uuid.New()
	created := make([]*model.Benchmark, 0, len(runs))
	for _, run := range runs {
		b, err := s.materializeRun(ctx, actor, ds.Name, runName(req.Name, run, len(runs) > 1), run, resolved, opts)
		if err != nil {
			return created, fmt.Errorf("%s: %w", runName(req.Name, run, true), err)
		}
		created = append(created, b)
	}
	if len(created) > 0 {
		s.recordHistory(ctx, actor, created[0].Compressors)
	}
	return created, nil
}

func (s *BenchmarkService) materializeRun(ctx context.Context, actor *model.User, datasetName, name string, run datasetRun, resolved []resolvedInstance, opts BenchmarkOptions) (*model.Benchmark, error) {
	benchmarkID := uuid.New()
	workRoot := filepath.Join(s.cfg.DataDir, benchmarkID.String())
	cleanup := func() { os.RemoveAll(workRoot) }

	hash, sum := dataset.NewHash()
	var binPaths []string
	var totalSize int64
	for i, series := range run.series {
		outDir := filepath.Join(workRoot, "inputs", fmt.Sprintf("%02d", i))
		outputs, err := dataset.Materialize(s.cfg.DatasetDir, datasetName, series, run.plan, outDir, hash)
		if err != nil {
			cleanup()
			return nil, err
		}
		for _, o := range outputs {
			binPaths = append(binPaths, o.Path)
			totalSize += 16 + int64(o.Values)*8
		}
	}

	var warnings []string
	if len(run.skipped) > 0 {
		warnings = append(warnings, fmt.Sprintf("skipped series shorter than one chunk of %d samples: %s",
			run.plan.ChunkSize, strings.Join(run.skipped, ", ")))
	}

	benchmark := &model.Benchmark{
		ID:               benchmarkID,
		UserID:           actor.ID,
		Name:             name,
		OriginalFilename: datasetName,
		FileSize:         totalSize,
		FileCount:        len(binPaths),
		FileChecksum:     sum(),
		FileExt:          "dataset",
		Aggregation:      opts.Aggregation,
		MeasureMemory:    opts.MeasureMemory,
		ExperimentID:     opts.ExperimentID,
		Warnings:         warnings,
		Source: &model.DatasetSource{
			Kind:      "dataset",
			Dataset:   datasetName,
			Series:    run.series,
			ChunkSize: run.plan.ChunkSize,
			MaxChunks: run.plan.MaxChunks,
			Transform: run.plan.Transform,
			Inputs:    len(binPaths),
		},
	}
	if err := s.enqueue(ctx, benchmark, binPaths, resolved); err != nil {
		cleanup()
		return nil, err
	}
	return benchmark, nil
}

func uniqueUints(values []uint64) []uint64 {
	seen := map[uint64]bool{}
	out := make([]uint64, 0, len(values))
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
