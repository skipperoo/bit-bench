package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/service"

	"github.com/google/uuid"
)

// ProgressHandler returns benchmark progress as JSON.
// Frontend polls this every 2s for active benchmarks.
func ProgressHandler(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	benchID, err := uuid.Parse(id)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	benchmark, err := service.App.Benchmark.GetBenchmarkStatus(r.Context(), benchID)
	if err != nil || benchmark == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"benchmark_id": benchmark.ID,
		"progress":     benchmark.Progress,
		"status":       benchmark.Status,
	})
}
