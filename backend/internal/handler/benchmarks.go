package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
)

func getClaims(r *http.Request) *model.Claims {
	c := middleware.ClaimsFromContext(r.Context())
	if c == nil {
		return nil
	}
	return c
}

func ListChecksums(w http.ResponseWriter, r *http.Request) {
	// TODO: query all file_checksum from benchmarks table
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode([]map[string]string{})
}

func CreateBenchmark(w http.ResponseWriter, r *http.Request) {
	// TODO: parse multipart form, validate file, compute MD5, insert row
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": "placeholder"})
}

func ListBenchmarks(w http.ResponseWriter, r *http.Request) {
	// TODO: query benchmarks with pagination, search, status filter
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode([]map[string]interface{}{})
}

func GetBenchmark(w http.ResponseWriter, r *http.Request) {
	// TODO: get benchmark by ID with results
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/benchmarks/")
	id = strings.Split(id, "/")[0]
	_ = id
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"id": id})
}

func GetBenchmarkStatus(w http.ResponseWriter, r *http.Request) {
	// TODO: get benchmark status
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "queued"})
}

func CompareBenchmarks(w http.ResponseWriter, r *http.Request) {
	// TODO: compare up to 5 benchmarks
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode([]map[string]interface{}{})
}

func GetStatus(w http.ResponseWriter, r *http.Request) {
	// TODO: return queue depth, runner status, stats
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"queue_depth": 0,
		"runner": map[string]int{
			"running":         0,
			"max_parallelism": 2,
		},
		"stats": map[string]int{
			"queued":      0,
			"in_progress": 0,
			"ready":       0,
			"failed":      0,
			"timed_out":   0,
			"cancelled":   0,
		},
	})
}
