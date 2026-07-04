//go:build integration

package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
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

func setupTestServer(t *testing.T) (*routy.Router, func()) {
	t.Helper()

	cfg := &config.Config{
		JWTSecret: "test-secret-for-integration-tests",
		JWTExpiry: 24 * time.Hour,
	}
	model.InitJWT(cfg.JWTSecret)

	// TODO: Use testcontainers for real postgres + redis
	// For now, this test is a placeholder that shows the pattern

	service.InitServices(cfg, nil, nil)
	middleware.InitAuthMiddleware(nil)

	recoverMw := routy.NewRecoverMiddleware(nil)
	loggingMw := routy.NewLoggingMiddleware(middleware.LoggingFunc)

	router := routy.NewRouter()
	router.
		AddMiddleware(recoverMw.GetMiddleware()).
		AddMiddleware(loggingMw.GetMiddleware()).
		AddHandler("POST /api/v1/auth/login", Login)

	cleanup := func() {}
	return router, cleanup
}

func TestLoginHandler(t *testing.T) {
	t.Skip("Integration test requires database; run with testcontainers")
	router, cleanup := setupTestServer(t)
	defer cleanup()
	_ = router
}

func TestLoginInvalidCredentials(t *testing.T) {
	t.Skip("Integration test requires database; run with testcontainers")
}

func TestLogoutBlocklist(t *testing.T) {
	t.Skip("Integration test requires Redis; run with testcontainers")
}

func TestChangePassword(t *testing.T) {
	t.Skip("Integration test requires database; run with testcontainers")
}
