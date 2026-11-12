package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

// chartShapesBody is the request and response of /me/chart-shapes.
type chartShapesBody struct {
	Shapes map[string]string `json:"shapes"`
}

// GetChartShapes returns the caller's chart marker shape overrides.
func GetChartShapes(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	shapes, err := service.UserRepo.GetChartShapes(r.Context(), user.ID)
	if err != nil {
		writeError(w, "failed to load chart shapes", http.StatusInternalServerError)
		return
	}
	if shapes == nil {
		shapes = map[string]string{}
	}
	writeJSON(w, http.StatusOK, chartShapesBody{Shapes: shapes})
}

// PutChartShapes replaces the caller's chart marker shape overrides; an empty
// map restores the defaults.
func PutChartShapes(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body chartShapesBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Shapes == nil {
		body.Shapes = map[string]string{}
	}
	if err := model.ValidateChartShapes(body.Shapes); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := service.UserRepo.SetChartShapes(r.Context(), user.ID, body.Shapes); err != nil {
		writeError(w, "failed to save chart shapes", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
