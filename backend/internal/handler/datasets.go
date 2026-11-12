package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"bitbench/internal/dataset"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

// ListDatasets returns the standardized datasets mounted at DATASET_DIR and
// the limits of a dataset run.
func ListDatasets(w http.ResponseWriter, r *http.Request) {
	datasets, err := service.App.Benchmark.ListDatasets()
	if err != nil {
		writeError(w, "failed to list datasets", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"datasets":              datasets,
		"transforms":            dataset.Transforms,
		"max_runs":              service.MaxDatasetRuns,
		"max_inputs_per_run":    dataset.MaxInputsPerRun,
		"max_chunks_per_series": dataset.MaxChunksPerSeries,
	})
}

// CreateDatasetBenchmarks enqueues one benchmark per (chunk size, transform)
// combination of a standardized dataset.
func CreateDatasetBenchmarks(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Cutting large series is synchronous; allow it to finish.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(40 * time.Minute))
	}

	var req service.DatasetRunRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	benchmarks, err := service.App.Benchmark.CreateDatasetBenchmarks(r.Context(), actor, req)
	if err != nil && len(benchmarks) == 0 {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "violates foreign key constraint") {
			status = http.StatusUnauthorized
		}
		writeError(w, err.Error(), status)
		return
	}
	if benchmarks == nil {
		benchmarks = []*model.Benchmark{}
	}
	resp := map[string]interface{}{"benchmarks": benchmarks}
	if err != nil {
		// Some combinations were created before one failed.
		resp["error"] = err.Error()
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(resp)
}
