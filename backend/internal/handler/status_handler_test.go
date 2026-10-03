//go:build integration

package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/skipperoo/routy"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

func setupStatusTest(t *testing.T) http.Handler {
	t.Helper()

	cfg := &config.Config{JWTSecret: "test-secret", JWTExpiry: 1 * time.Hour, MaxParallelism: 2}
	model.InitJWT(cfg.JWTSecret)
	service.InitServices(cfg, testDB, testRDB)
	middleware.InitAuthMiddleware(testRDB)

	router := routy.NewRouter()
	protected := routy.NewRouter()
	protected.AddMiddleware(middleware.JWTAuth)
	protected.AddHandler("GET /status", GetStatus)
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize()
}

func TestGetStatusRequiresAuth(t *testing.T) {
	handler := setupStatusTest(t)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/v1/status", nil)
	handler.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestGetStatusIncludesCPU(t *testing.T) {
	handler := setupStatusTest(t)

	var userID string
	if err := testDB.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = 'user@test.com'`).Scan(&userID); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	token, err := model.GenerateToken(userID, "user@test.com", "user", "", time.Hour)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/v1/status", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp model.StatusResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.CPU == nil {
		t.Fatal("expected cpu info in status response")
	}
	if resp.CPU.LogicalCores <= 0 {
		t.Errorf("logical_cores = %d, want > 0", resp.CPU.LogicalCores)
	}
	if resp.CPU.Flags == nil {
		t.Error("expected instruction-set flags array (may be empty), got nil")
	}
}
