package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

// GetChartStyles returns the caller's chart shape and colour overrides.
func GetChartStyles(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	styles, err := service.UserRepo.GetChartStyles(r.Context(), user.ID)
	if err != nil {
		writeError(w, "failed to load chart styles", http.StatusInternalServerError)
		return
	}
	if styles == nil {
		styles = &model.ChartStyles{Shapes: map[string]string{}, Colors: map[string]string{}, Names: map[string]string{}}
	}
	writeJSON(w, http.StatusOK, styles)
}

// PutChartStyles replaces the caller's chart shape and colour overrides;
// empty maps restore the defaults.
func PutChartStyles(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body model.ChartStyles
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&body); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := model.ValidateChartStyles(&body); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := service.UserRepo.SetChartStyles(r.Context(), user.ID, &body); err != nil {
		writeError(w, "failed to save chart styles", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
