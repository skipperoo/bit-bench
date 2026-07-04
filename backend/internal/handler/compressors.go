package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/compressor"
)

func ListCompressors(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(compressor.Registry)
}
