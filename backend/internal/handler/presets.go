package handler

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

// CreatePreset saves the current configuration as a private or group-shared
// preset. Every authenticated role may create presets.
func CreatePreset(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Name        string          `json:"name"`
		Visibility  string          `json:"visibility"`
		Compressors json.RawMessage `json:"compressors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if len(req.Compressors) == 0 {
		writeError(w, "compressors are required", http.StatusBadRequest)
		return
	}

	preset, err := service.App.Preset.Create(r.Context(), actor, req.Name, req.Visibility, req.Compressors)
	if err != nil {
		writeServiceError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(preset)
}

// ListPresets returns the presets visible to the caller.
func ListPresets(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	presets, err := service.App.Preset.List(r.Context(), actor)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if presets == nil {
		presets = []*model.BenchmarkPreset{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(presets)
}

// UpdatePreset renames, re-scopes or replaces a preset configuration.
func UpdatePreset(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid preset id", http.StatusBadRequest)
		return
	}

	var req struct {
		Name        *string         `json:"name"`
		Visibility  *string         `json:"visibility"`
		Compressors json.RawMessage `json:"compressors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	preset, err := service.App.Preset.Update(r.Context(), actor, id, service.PresetUpdate{
		Name:        req.Name,
		Visibility:  req.Visibility,
		Compressors: req.Compressors,
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(preset)
}

func DeletePreset(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid preset id", http.StatusBadRequest)
		return
	}

	if err := service.App.Preset.Delete(r.Context(), actor, id); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListConfigHistory returns the caller's most recently used configurations.
func ListConfigHistory(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	entries, err := service.App.Preset.ListHistory(r.Context(), actor)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if entries == nil {
		entries = []*model.BenchmarkConfigHistory{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}
