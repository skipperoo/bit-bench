package handler

import (
	"encoding/json"
	"net/http"
)

// ProgressHandler returns benchmark progress as JSON (same payload as the
// status endpoint). The frontend polls it every 2s for active benchmarks.
func ProgressHandler(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(benchmarkStatusPayload(benchmark))
}
