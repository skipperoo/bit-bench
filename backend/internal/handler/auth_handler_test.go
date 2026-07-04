//go:build integration

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/skipperoo/routy"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	tcRedis "github.com/testcontainers/testcontainers-go/modules/redis"
	"golang.org/x/crypto/bcrypt"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

var testDB *pgxpool.Pool
var testRDB *goredis.Client

func TestMain(m *testing.M) {
	ctx := context.Background()

	pgC, err := postgres.Run(ctx,
		"postgres:18-alpine",
		postgres.WithDatabase("bitbench_test"),
		postgres.WithUsername("bitbench"),
		postgres.WithPassword("testpass"),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to start postgres: %v\n", err)
		os.Exit(1)
	}

	connStr, err := pgC.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to get conn string: %v\n", err)
		os.Exit(1)
	}

	testDB, err = pgxpool.New(ctx, connStr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to connect: %v\n", err)
		os.Exit(1)
	}

	// Run migrations
	if err := config.RunMigrations(ctx, testDB); err != nil {
		fmt.Fprintf(os.Stderr, "migrations failed: %v\n", err)
		os.Exit(1)
	}

	// Seed admin user directly (not via config.Seed to avoid default group creation)
	hash, _ := bcrypt.GenerateFromPassword([]byte("adminpass"), bcrypt.DefaultCost)
	testDB.Exec(ctx, `INSERT INTO groups (name, priority) VALUES ('default', 0)`)
	testDB.Exec(ctx, `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')`, "admin@test.com", string(hash))
	testDB.Exec(ctx, `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'user')`, "user@test.com", string(hash))

	// Start Redis
	redisC, err := tcRedis.Run(ctx,
		"redis:7-alpine",
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to start redis: %v\n", err)
		os.Exit(1)
	}
	redisConn, _ := redisC.ConnectionString(ctx)
	redisOpts, _ := goredis.ParseURL(redisConn)
	testRDB = goredis.NewClient(redisOpts)

	code := m.Run()

	testDB.Close()
	testRDB.Close()
	pgC.Terminate(ctx)
	redisC.Terminate(ctx)
	os.Exit(code)
}

func setupAuthTest(t *testing.T) *routy.Router {
	t.Helper()

	cfg := &config.Config{
		JWTSecret: "test-secret",
		JWTExpiry: 1 * time.Hour,
	}
	model.InitJWT(cfg.JWTSecret)
	service.InitServices(cfg, testDB, testRDB)
	middleware.InitAuthMiddleware(testRDB)

	recoverMw := routy.NewRecoverMiddleware(nil)
	loggingMw := routy.NewLoggingMiddleware(middleware.LoggingFunc)

	router := routy.NewRouter()
	router.
		AddMiddleware(recoverMw.GetMiddleware()).
		AddMiddleware(loggingMw.GetMiddleware())
	router.AddHandler("POST /api/v1/auth/login", Login)

	protected := routy.NewRouter()
	protected.AddMiddleware(middleware.JWTAuth)
	protected.AddHandler("POST /v1/auth/logout", Logout)
	protected.AddHandler("GET /v1/me", Me)

	router.AddSubroute("/api/", protected.Finalize())
	return router
}

func TestLoginSuccess(t *testing.T) {
	router := setupAuthTest(t)
	handler := router.Finalize()

	body, _ := json.Marshal(model.LoginRequest{Email: "admin@test.com", Password: "adminpass"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp model.LoginResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("token is empty")
	}
}

func TestLoginInvalidCredentials(t *testing.T) {
	router := setupAuthTest(t)
	handler := router.Finalize()

	body, _ := json.Marshal(model.LoginRequest{Email: "admin@test.com", Password: "wrongpass"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

func TestLoginNonexistentUser(t *testing.T) {
	router := setupAuthTest(t)
	handler := router.Finalize()

	body, _ := json.Marshal(model.LoginRequest{Email: "nobody@test.com", Password: "pass"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestLogoutBlocklist(t *testing.T) {
	router := setupAuthTest(t)
	handler := router.Finalize()

	// Login first
	body, _ := json.Marshal(model.LoginRequest{Email: "admin@test.com", Password: "adminpass"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(w, r)

	var loginResp model.LoginResponse
	json.NewDecoder(w.Body).Decode(&loginResp)
	token := loginResp.Token

	// Logout
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest("POST", "/api/v1/auth/logout", nil)
	r2.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(w2, r2)

	if w2.Code != http.StatusOK {
		t.Fatalf("logout expected 200, got %d", w2.Code)
	}

	// Verify token is blocked by trying to access /me
	w3 := httptest.NewRecorder()
	r3 := httptest.NewRequest("GET", "/api/v1/me", nil)
	r3.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(w3, r3)

	if w3.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for blocked token, got %d", w3.Code)
	}
}

func TestMeEndpoint(t *testing.T) {
	router := setupAuthTest(t)
	handler := router.Finalize()

	// Login
	body, _ := json.Marshal(model.LoginRequest{Email: "admin@test.com", Password: "adminpass"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(w, r)

	var loginResp model.LoginResponse
	json.NewDecoder(w.Body).Decode(&loginResp)

	// Access /me
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest("GET", "/api/v1/me", nil)
	r2.Header.Set("Authorization", "Bearer "+loginResp.Token)
	handler.ServeHTTP(w2, r2)

	if w2.Code != http.StatusOK {
		t.Fatalf("/me expected 200, got %d", w2.Code)
	}

	var user model.User
	json.NewDecoder(w2.Body).Decode(&user)

	if user.Email != "admin@test.com" {
		t.Errorf("email = %q, want admin@test.com", user.Email)
	}
}

func TestUnauthenticatedRequest(t *testing.T) {
	router := setupAuthTest(t)
	handler := router.Finalize()

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/v1/me", nil)

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}
