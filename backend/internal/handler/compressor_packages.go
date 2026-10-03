package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"bitbench/internal/logger"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

// UploadCompressorPackage accepts a .zip package from admin/professor/phd and
// starts its build asynchronously.
func UploadCompressorPackage(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeError(w, "failed to parse form", http.StatusBadRequest)
		return
	}

	var groupID *uuid.UUID
	if actor.Role == "admin" {
		if gidStr := r.FormValue("group_id"); gidStr != "" {
			gid, err := uuid.Parse(gidStr)
			if err != nil {
				writeError(w, "invalid group_id", http.StatusBadRequest)
				return
			}
			groupID = &gid
		}
	} else {
		groupID = actor.GroupID
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, "file is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	pkg, err := service.App.Compressor.UploadPackage(r.Context(), actor, groupID, file, header.Filename)
	if err != nil {
		writeServiceError(w, err)
		return
	}

	id := pkg.ID
	go func() {
		if err := service.App.Compressor.Build(context.Background(), id); err != nil {
			logger.Error("compressor build failed", "package", id, "error", err)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(pkg)
}

func ListCompressorPackages(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	packages, err := service.App.Compressor.ListVisible(r.Context(), actor)
	if err != nil {
		writeError(w, "failed to list packages", http.StatusInternalServerError)
		return
	}
	if packages == nil {
		packages = []*model.CompressorPackage{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(packages)
}

func GetCompressorPackage(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid package id", http.StatusBadRequest)
		return
	}

	packages, err := service.App.Compressor.ListVisible(r.Context(), actor)
	if err != nil {
		writeError(w, "failed to get package", http.StatusInternalServerError)
		return
	}
	for _, pkg := range packages {
		if pkg.ID == id {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(pkg)
			return
		}
	}
	writeError(w, "package not found", http.StatusNotFound)
}

func DeleteCompressorPackage(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid package id", http.StatusBadRequest)
		return
	}

	if err := service.App.Compressor.DeletePackage(r.Context(), actor, id); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrBadRequest):
		writeError(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, service.ErrForbidden):
		writeError(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, service.ErrNotFound):
		writeError(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, service.ErrConflict):
		writeError(w, err.Error(), http.StatusConflict)
	default:
		writeError(w, err.Error(), http.StatusInternalServerError)
	}
}
