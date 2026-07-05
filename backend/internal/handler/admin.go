package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/service"
)

// ─── Users ────────────────────────────────────────────────

func AdminCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string  `json:"email"`
		Password string  `json:"password"`
		Role     string  `json:"role"`
		GroupID  *string `json:"group_id,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Password == "" {
		writeError(w, "email and password are required", http.StatusBadRequest)
		return
	}
	if req.Role != "admin" && req.Role != "user" {
		req.Role = "user"
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, "failed to hash password", http.StatusInternalServerError)
		return
	}

	user := &model.User{
		Email:              req.Email,
		PasswordHash:       string(hash),
		Role:               req.Role,
		MustChangePassword: false,
	}
	if req.GroupID != nil {
		gid, err := uuid.Parse(*req.GroupID)
		if err == nil {
			user.GroupID = &gid
		}
	}

	if err := service.UserRepo.Create(r.Context(), user); err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			writeError(w, "email already exists", http.StatusConflict)
			return
		}
		writeError(w, "failed to create user", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(user)
}

func AdminListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := service.UserRepo.List(r.Context())
	if err != nil {
		writeError(w, "failed to list users", http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []*model.User{}
	}

	type userResp struct {
		ID                 uuid.UUID  `json:"id"`
		Email              string     `json:"email"`
		Role               string     `json:"role"`
		GroupID            *uuid.UUID `json:"group_id,omitempty"`
		MustChangePassword bool       `json:"must_change_password"`
		CreatedAt          string     `json:"created_at"`
	}
	resp := make([]userResp, len(users))
	for i, u := range users {
		resp[i] = userResp{
			ID:                 u.ID,
			Email:              u.Email,
			Role:               u.Role,
			GroupID:            u.GroupID,
			MustChangePassword: u.MustChangePassword,
			CreatedAt:          u.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func AdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, "invalid user id", http.StatusBadRequest)
		return
	}

	var req struct {
		Role          *string `json:"role,omitempty"`
		GroupID       *string `json:"group_id,omitempty"`
		ResetPassword *string `json:"reset_password,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Role != nil && *req.Role != "admin" && *req.Role != "user" {
		writeError(w, "role must be 'admin' or 'user'", http.StatusBadRequest)
		return
	}

	var newHash *string
	if req.ResetPassword != nil && *req.ResetPassword != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(*req.ResetPassword), bcrypt.DefaultCost)
		if err != nil {
			writeError(w, "failed to hash password", http.StatusInternalServerError)
			return
		}
		s := string(hash)
		newHash = &s
	}

	if err := service.UserRepo.Update(r.Context(), userID, req.Role, req.GroupID, newHash); err != nil {
		writeError(w, "failed to update user", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func AdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, "invalid user id", http.StatusBadRequest)
		return
	}

	if err := service.UserRepo.SoftDelete(r.Context(), userID); err != nil {
		writeError(w, "failed to delete user", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Groups ───────────────────────────────────────────────

func AdminCreateGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Priority int    `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		writeError(w, "name is required", http.StatusBadRequest)
		return
	}

	group := &model.Group{
		Name:     req.Name,
		Priority: req.Priority,
	}
	if err := service.GroupRepo.Create(r.Context(), group); err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			writeError(w, "group name already exists", http.StatusConflict)
			return
		}
		writeError(w, "failed to create group", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(group)
}

func AdminListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := service.GroupRepo.List(r.Context())
	if err != nil {
		writeError(w, "failed to list groups", http.StatusInternalServerError)
		return
	}
	if groups == nil {
		groups = []*model.Group{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(groups)
}

func AdminUpdateGroup(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	groupID, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, "invalid group id", http.StatusBadRequest)
		return
	}

	var req struct {
		Name     *string `json:"name,omitempty"`
		Priority *int    `json:"priority,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if err := service.GroupRepo.Update(r.Context(), groupID, req.Name, req.Priority); err != nil {
		writeError(w, "failed to update group", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func AdminDeleteGroup(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	groupID, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, "invalid group id", http.StatusBadRequest)
		return
	}

	if err := service.GroupRepo.Delete(r.Context(), groupID); err != nil {
		writeError(w, "failed to delete group", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Benchmarks ───────────────────────────────────────────

func AdminListBenchmarks(w http.ResponseWriter, r *http.Request) {
	limit := 50
	cursor := r.URL.Query().Get("cursor")
	var cursorTime *time.Time
	if cursor != "" {
		if t, err := time.Parse(time.RFC3339Nano, cursor); err == nil {
			cursorTime = &t
		}
	}

	result, err := service.BenchRepo.List(r.Context(), repository.ListBenchmarksParams{
		Cursor: cursorTime,
		Limit:  limit,
	})
	if err != nil {
		writeError(w, "failed to list benchmarks", http.StatusInternalServerError)
		return
	}

	benchmarks := result.Benchmarks
	if benchmarks == nil {
		benchmarks = []*model.Benchmark{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"benchmarks":  benchmarks,
		"next_cursor": result.NextCursor,
	})
}

func AdminBatchDeleteBenchmarks(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var errs []string
	for _, idStr := range req.IDs {
		benchID, err := uuid.Parse(idStr)
		if err != nil {
			errs = append(errs, fmt.Sprintf("invalid id %s: %v", idStr, err))
			continue
		}
		benchmark, err := service.BenchRepo.FindByID(r.Context(), benchID)
		if err != nil || benchmark == nil {
			errs = append(errs, fmt.Sprintf("not found: %s", idStr))
			continue
		}
		workDir := filepath.Join(AppConfig.DataDir, benchID.String())
		os.RemoveAll(workDir)
		srcName := service.StoredFilename(benchmark.OriginalFilename, benchmark.FileChecksum)
		os.Remove(filepath.Join(AppConfig.DataDir, srcName))
		if err := service.BenchRepo.Delete(r.Context(), benchID); err != nil {
			errs = append(errs, fmt.Sprintf("delete %s: %v", idStr, err))
		}
	}

	if len(errs) > 0 {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"deleted": len(req.IDs) - len(errs),
			"errors":  errs,
		})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func AdminDeleteBenchmark(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	benchID, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, "invalid benchmark id", http.StatusBadRequest)
		return
	}

	// Look up benchmark to find source file
	benchmark, err := service.BenchRepo.FindByID(r.Context(), benchID)
	if err != nil || benchmark == nil {
		writeError(w, "benchmark not found", http.StatusNotFound)
		return
	}

	// Delete working directory
	workDir := filepath.Join(AppConfig.DataDir, benchID.String())
	os.RemoveAll(workDir)

	// Delete stored source file
	srcName := service.StoredFilename(benchmark.OriginalFilename, benchmark.FileChecksum)
	srcPath := filepath.Join(AppConfig.DataDir, srcName)
	os.Remove(srcPath)

	if err := service.BenchRepo.Delete(r.Context(), benchID); err != nil {
		writeError(w, "failed to delete benchmark", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func AdminCancelBenchmark(w http.ResponseWriter, r *http.Request) {
	benchID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid benchmark id", http.StatusBadRequest)
		return
	}

	benchmark, err := service.BenchRepo.FindByID(r.Context(), benchID)
	if err != nil || benchmark == nil {
		writeError(w, "benchmark not found", http.StatusNotFound)
		return
	}

	if benchmark.Status != "queued" && benchmark.Status != "in_progress" {
		writeError(w, "can only cancel queued or in_progress benchmarks", http.StatusBadRequest)
		return
	}

	errMsg := "cancelled by admin"
	if err := service.BenchRepo.UpdateStatus(r.Context(), benchID, "cancelled", &errMsg); err != nil {
		writeError(w, "failed to cancel benchmark", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "cancelled"})
}
