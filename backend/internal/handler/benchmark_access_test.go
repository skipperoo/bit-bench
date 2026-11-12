//go:build integration

package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/skipperoo/routy"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
)

// setupBenchmarkReadTest mounts the read endpoints next to the create route.
func setupBenchmarkReadTest(t *testing.T) http.Handler {
	t.Helper()
	_ = setupBenchmarkTest(t) // initializes services, JWT and middleware
	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST /benchmarks", CreateBenchmark).
		AddHandler("GET /benchmarks/{id}", GetBenchmark).
		AddHandler("GET /benchmarks/{id}/status", GetBenchmarkStatus).
		AddHandler("GET /benchmarks/{id}/progress", ProgressHandler)
	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize()
}

func getWithToken(handler http.Handler, path, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestBenchmarkReadsAreOwnerOrAdminOnly(t *testing.T) {
	handler := setupBenchmarkReadTest(t)
	owner := tokenFor(t, "user@test.com")
	createTestUser(t, "intruder@test.com", model.RoleStudent, nil)
	t.Cleanup(func() {
		testDB.Exec(context.Background(), `DELETE FROM users WHERE email = 'intruder@test.com'`)
	})
	intruder := tokenFor(t, "intruder@test.com")
	admin := tokenFor(t, "admin@test.com")

	w := doCreateBenchmark(handler, owner, "private", map[string][]byte{"a.bin": sampleBinBytes(t, 16)})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var b model.Benchmark
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{
		"/api/v1/benchmarks/" + b.ID.String(),
		"/api/v1/benchmarks/" + b.ID.String() + "/status",
		"/api/v1/benchmarks/" + b.ID.String() + "/progress",
	} {
		if w := getWithToken(handler, path, owner); w.Code != http.StatusOK {
			t.Errorf("owner GET %s = %d, want 200", path, w.Code)
		}
		if w := getWithToken(handler, path, admin); w.Code != http.StatusOK {
			t.Errorf("admin GET %s = %d, want 200", path, w.Code)
		}
		if w := getWithToken(handler, path, intruder); w.Code != http.StatusNotFound {
			t.Errorf("other user GET %s = %d, want 404", path, w.Code)
		}
	}
}

func TestSoftDeletedEmailCanBeReused(t *testing.T) {
	_ = setupBenchmarkTest(t)
	ctx := context.Background()
	id := createTestUser(t, "Reuse@Test.com", model.RoleStudent, nil)
	if _, err := testDB.Exec(ctx, `UPDATE users SET deleted_at = NOW() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testDB.Exec(ctx, `DELETE FROM users WHERE LOWER(email) = 'reuse@test.com'`) })

	// Migration 0011: uniqueness only among active users, case-insensitive.
	if _, err := testDB.Exec(ctx, `INSERT INTO users (email, password_hash, role) VALUES ('reuse@test.com', 'x', 'student')`); err != nil {
		t.Fatalf("re-creating a soft-deleted user's email failed: %v", err)
	}
	if _, err := testDB.Exec(ctx, `INSERT INTO users (email, password_hash, role) VALUES ('REUSE@test.com', 'x', 'student')`); err == nil {
		t.Fatal("a case-variant duplicate of an active email must be rejected")
	}
}
