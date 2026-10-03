//go:build integration

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/skipperoo/routy"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

func setupAdminTest(t *testing.T) http.Handler {
	t.Helper()

	cfg := &config.Config{JWTSecret: "test-secret", JWTExpiry: 1 * time.Hour, MaxParallelism: 2}
	model.InitJWT(cfg.JWTSecret)
	service.InitServices(cfg, testDB, testRDB)
	service.InitRepos(testDB)
	middleware.InitAuthMiddleware(testRDB)
	middleware.InitUserResolver(service.UserRepo)

	admin := routy.NewRouter()
	admin.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST   /users", middleware.RequireAdminOrProfessor(AdminCreateUser)).
		AddHandler("GET    /users", middleware.RequireAdminOrProfessor(AdminListUsers)).
		AddHandler("PUT    /users/{id}", middleware.RequireAdminOrProfessor(AdminUpdateUser)).
		AddHandler("DELETE /users/{id}", middleware.RequireAdminOrProfessor(AdminDeleteUser)).
		AddHandler("POST   /groups", middleware.RequireAdmin(AdminCreateGroup)).
		AddHandler("GET    /groups", middleware.RequireAdminOrProfessor(AdminListGroups)).
		AddHandler("PUT    /groups/{id}", middleware.RequireAdmin(AdminUpdateGroup)).
		AddHandler("DELETE /groups/{id}", middleware.RequireAdmin(AdminDeleteGroup))

	router := routy.NewRouter()
	router.AddSubroute("/api/v1/admin/", admin.Finalize())
	return router.Finalize()
}

func userIDByEmail(t *testing.T, email string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testDB.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, email).Scan(&id); err != nil {
		t.Fatalf("lookup user %s: %v", email, err)
	}
	return id
}

func groupIDByName(t *testing.T, name string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testDB.QueryRow(context.Background(),
		`SELECT id FROM groups WHERE name = $1`, name).Scan(&id); err != nil {
		t.Fatalf("lookup group %s: %v", name, err)
	}
	return id
}

func tokenFor(t *testing.T, email string) string {
	t.Helper()
	id := userIDByEmail(t, email)
	var role, groupID string
	if err := testDB.QueryRow(context.Background(),
		`SELECT role, COALESCE(group_id::text, '') FROM users WHERE id = $1`, id).Scan(&role, &groupID); err != nil {
		t.Fatalf("lookup claims for %s: %v", email, err)
	}
	token, err := model.GenerateToken(id.String(), email, role, groupID, time.Hour)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	return token
}

func createTestUser(t *testing.T, email, role string, groupID *uuid.UUID) uuid.UUID {
	t.Helper()
	user := &model.User{
		Email:        email,
		PasswordHash: "x",
		Role:         role,
		GroupID:      groupID,
	}
	if err := service.UserRepo.Create(context.Background(), user); err != nil {
		t.Fatalf("create user %s: %v", email, err)
	}
	return user.ID
}

func doRequest(handler http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, reader)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestAdminListUsersScopedByRole(t *testing.T) {
	handler := setupAdminTest(t)

	// Student cannot access the admin API at all.
	w := doRequest(handler, "GET", "/api/v1/admin/users", tokenFor(t, "user@test.com"), nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("student GET /admin/users = %d, want 403", w.Code)
	}

	// Admin sees users from every group.
	w = doRequest(handler, "GET", "/api/v1/admin/users", tokenFor(t, "admin@test.com"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin GET /admin/users = %d: %s", w.Code, w.Body.String())
	}
	var all []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &all); err != nil {
		t.Fatalf("decode users: %v", err)
	}
	if len(all) < 5 {
		t.Errorf("admin sees %d users, want >= 5", len(all))
	}

	// Professor sees only users of their own group.
	w = doRequest(handler, "GET", "/api/v1/admin/users", tokenFor(t, "professor@test.com"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("professor GET /admin/users = %d: %s", w.Code, w.Body.String())
	}
	var scoped []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &scoped); err != nil {
		t.Fatalf("decode users: %v", err)
	}
	if len(scoped) == 0 {
		t.Fatal("professor sees no users")
	}
	groupA := groupIDByName(t, "group-a")
	for _, u := range scoped {
		if u["group_id"] != groupA.String() {
			t.Errorf("professor sees user from another group: %v", u)
		}
	}
}

func TestProfessorCreateUser(t *testing.T) {
	handler := setupAdminTest(t)
	profToken := tokenFor(t, "professor@test.com")
	groupA := groupIDByName(t, "group-a")

	w := doRequest(handler, "POST", "/api/v1/admin/users", profToken, map[string]any{
		"email":    "prof-created@test.com",
		"password": "secret1",
		"role":     "phd",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("professor create phd = %d: %s", w.Code, w.Body.String())
	}
	var created model.User
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode user: %v", err)
	}
	if created.GroupID == nil || *created.GroupID != groupA {
		t.Errorf("created user group = %v, want professor's group %v", created.GroupID, groupA)
	}
	if created.Role != model.RolePhD {
		t.Errorf("created role = %q, want phd", created.Role)
	}

	w = doRequest(handler, "POST", "/api/v1/admin/users", profToken, map[string]any{
		"email":    "prof-admin@test.com",
		"password": "secret1",
		"role":     "admin",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor create admin = %d, want 403", w.Code)
	}

	// Default role is student.
	w = doRequest(handler, "POST", "/api/v1/admin/users", profToken, map[string]any{
		"email":    "prof-default@test.com",
		"password": "secret1",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("professor create default = %d: %s", w.Code, w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if created.Role != model.RoleStudent {
		t.Errorf("default created role = %q, want student", created.Role)
	}
}

func TestProfessorUpdateOwnGroupUser(t *testing.T) {
	handler := setupAdminTest(t)
	profToken := tokenFor(t, "professor@test.com")
	groupA := groupIDByName(t, "group-a")
	groupB := groupIDByName(t, "group-b")
	target := createTestUser(t, "promote-me@test.com", model.RoleStudent, &groupA)

	// Promote student -> phd: allowed.
	w := doRequest(handler, "PUT", "/api/v1/admin/users/"+target.String(), profToken, map[string]any{"role": "phd"})
	if w.Code != http.StatusOK {
		t.Fatalf("professor promote to phd = %d: %s", w.Code, w.Body.String())
	}

	// Promote phd -> professor: forbidden.
	w = doRequest(handler, "PUT", "/api/v1/admin/users/"+target.String(), profToken, map[string]any{"role": "professor"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor promote to professor = %d, want 403", w.Code)
	}

	// Change group: forbidden.
	w = doRequest(handler, "PUT", "/api/v1/admin/users/"+target.String(), profToken, map[string]any{"group_id": groupB.String()})
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor change group = %d, want 403", w.Code)
	}

	// Reset password: allowed.
	w = doRequest(handler, "PUT", "/api/v1/admin/users/"+target.String(), profToken, map[string]any{"reset_password": "newsecret"})
	if w.Code != http.StatusOK {
		t.Fatalf("professor reset password = %d: %s", w.Code, w.Body.String())
	}

	// User in another group: forbidden.
	outsider := createTestUser(t, "outsider@test.com", model.RoleStudent, &groupB)
	w = doRequest(handler, "PUT", "/api/v1/admin/users/"+outsider.String(), profToken, map[string]any{"role": "phd"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor update outsider = %d, want 403", w.Code)
	}
}

func TestProfessorDeleteScopes(t *testing.T) {
	handler := setupAdminTest(t)
	profToken := tokenFor(t, "professor@test.com")
	groupA := groupIDByName(t, "group-a")

	victim := createTestUser(t, "delete-me@test.com", model.RolePhD, &groupA)
	w := doRequest(handler, "DELETE", "/api/v1/admin/users/"+victim.String(), profToken, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("professor delete own-group phd = %d: %s", w.Code, w.Body.String())
	}

	// A peer professor is protected.
	peer := createTestUser(t, "peer-prof@test.com", model.RoleProfessor, &groupA)
	w = doRequest(handler, "DELETE", "/api/v1/admin/users/"+peer.String(), profToken, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor delete peer = %d, want 403", w.Code)
	}
}

func TestProfessorGroupAccess(t *testing.T) {
	handler := setupAdminTest(t)
	profToken := tokenFor(t, "professor@test.com")
	groupA := groupIDByName(t, "group-a")

	w := doRequest(handler, "GET", "/api/v1/admin/groups", profToken, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("professor GET groups = %d: %s", w.Code, w.Body.String())
	}
	var groups []model.Group
	if err := json.Unmarshal(w.Body.Bytes(), &groups); err != nil {
		t.Fatalf("decode groups: %v", err)
	}
	if len(groups) != 1 || groups[0].ID != groupA {
		t.Errorf("professor groups = %+v, want only group-a", groups)
	}

	w = doRequest(handler, "POST", "/api/v1/admin/groups", profToken, map[string]any{"name": "nope", "priority": 1})
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor create group = %d, want 403", w.Code)
	}
	w = doRequest(handler, "PUT", "/api/v1/admin/groups/"+groupA.String(), profToken, map[string]any{"priority": 99})
	if w.Code != http.StatusForbidden {
		t.Fatalf("professor update group = %d, want 403", w.Code)
	}
}

func TestDeletedUserTokenRejected(t *testing.T) {
	handler := setupAdminTest(t)
	adminToken := tokenFor(t, "admin@test.com")
	groupA := groupIDByName(t, "group-a")
	victim := createTestUser(t, "ghost@test.com", model.RoleStudent, &groupA)
	victimToken := tokenFor(t, "ghost@test.com")

	w := doRequest(handler, "DELETE", "/api/v1/admin/users/"+victim.String(), adminToken, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("admin delete user = %d: %s", w.Code, w.Body.String())
	}

	w = doRequest(handler, "GET", "/api/v1/admin/users", victimToken, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("deleted user token = %d, want 401", w.Code)
	}
}

func TestAdminCannotDeleteSelf(t *testing.T) {
	handler := setupAdminTest(t)
	adminID := userIDByEmail(t, "admin@test.com")

	w := doRequest(handler, "DELETE", "/api/v1/admin/users/"+adminID.String(), tokenFor(t, "admin@test.com"), nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("admin delete self = %d, want 400", w.Code)
	}
}

func TestRoleValidation(t *testing.T) {
	handler := setupAdminTest(t)
	adminToken := tokenFor(t, "admin@test.com")

	for _, invalid := range []string{"user", "root", ""} {
		body := map[string]any{"email": fmt.Sprintf("bad-%s@test.com", invalid), "password": "secret1"}
		if invalid != "" {
			body["role"] = invalid
		} else {
			continue // empty role defaults to student
		}
		w := doRequest(handler, "POST", "/api/v1/admin/users", adminToken, body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("create role %q = %d, want 400", invalid, w.Code)
		}
	}
}
