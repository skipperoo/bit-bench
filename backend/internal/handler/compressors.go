package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/compressor"
	"bitbench/internal/middleware"
	"bitbench/internal/service"
)

func ListCompressors(w http.ResponseWriter, r *http.Request) {
	merged := make(map[string]map[string]compressor.Option, len(compressor.Registry)+4)
	for name, options := range compressor.Registry {
		merged[name] = options
	}

	if actor := middleware.UserFromContext(r.Context()); actor != nil {
		custom, err := service.App.Compressor.VisibleOptions(r.Context(), actor)
		if err == nil {
			for name, options := range custom {
				if _, exists := merged[name]; !exists {
					merged[name] = options
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(merged)
}
