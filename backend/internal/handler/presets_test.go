//go:build integration

package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/skipperoo/routy"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

func setupPresetTest(t *testing.T) http.Handler {
	t.Helper()

	cfg := &config.Config{
		JWTSecret:      "test-secret",
		JWTExpiry:      1 * time.Hour,
		MaxParallelism: 8,
		MaxFileSizeMB:  10,
		DataDir:        t.TempDir(),
	}
	model.InitJWT(cfg.JWTSecret)
	service.InitServices(cfg, testDB, testRDB)
	service.InitRepos(testDB)
	middleware.InitAuthMiddleware(testRDB)
	middleware.InitUserResolver(service.UserRepo)

	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("GET /presets", ListPresets).
		AddHandler("POST /presets", CreatePreset).
		AddHandler("PUT /presets/{id}", UpdatePreset).
		AddHandler("DELETE /presets/{id}", DeletePreset).
		AddHandler("GET /config-history", ListConfigHistory).
		AddHandler("POST /benchmarks", CreateBenchmark)

	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize()
}

func presetPayload(name, visibility string, level int) map[string]any {
	return map[string]any{
		"name":       name,
		"visibility": visibility,
		"compressors": []map[string]any{
			{"name": "gzip", "options": map[string]any{"level": level}},
		},
	}
}

func TestPresetCreateAnyRoleAndUniqueName(t *testing.T) {
	handler := setupPresetTest(t)
	token := tokenFor(t, "user@test.com") // student

	// Students can create presets.
	w := doRequest(handler, "POST", "/api/v1/presets", token, presetPayload("student preset", "private", 9))
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var preset model.BenchmarkPreset
	if err := json.Unmarshal(w.Body.Bytes(), &preset); err != nil {
		t.Fatalf("decode preset: %v", err)
	}
	if preset.Visibility != "private" || len(preset.Compressors) != 1 {
		t.Errorf("preset = %+v", preset)
	}
	if preset.Compressors[0].Label != "gzip · level 9" {
		t.Errorf("label = %q", preset.Compressors[0].Label)
	}

	// Names are unique per owner.
	w = doRequest(handler, "POST", "/api/v1/presets", token, presetPayload("student preset", "private", 1))
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate name = %d, want 409: %s", w.Code, w.Body.String())
	}

	// Invalid visibility is rejected.
	w = doRequest(handler, "POST", "/api/v1/presets", token, presetPayload("bad", "public", 1))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad visibility = %d, want 400: %s", w.Code, w.Body.String())
	}
}

func TestPresetVisibility(t *testing.T) {
	handler := setupPresetTest(t)
	profToken := tokenFor(t, "professor@test.com") // group-a

	w := doRequest(handler, "POST", "/api/v1/presets", profToken, presetPayload("shared preset", "group", 9))
	if w.Code != http.StatusCreated {
		t.Fatalf("create group preset = %d: %s", w.Code, w.Body.String())
	}
	var shared model.BenchmarkPreset
	json.Unmarshal(w.Body.Bytes(), &shared)

	w = doRequest(handler, "POST", "/api/v1/presets", profToken, presetPayload("private preset", "private", 1))
	if w.Code != http.StatusCreated {
		t.Fatalf("create private preset = %d: %s", w.Code, w.Body.String())
	}

	// Same group (phd) sees the shared preset but not the private one.
	w = doRequest(handler, "GET", "/api/v1/presets", tokenFor(t, "phd@test.com"), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("phd list = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "shared preset") || strings.Contains(body, "private preset") {
		t.Errorf("phd presets = %s", body)
	}

	// Other group does not see the shared preset.
	w = doRequest(handler, "GET", "/api/v1/presets", tokenFor(t, "other@test.com"), nil)
	if strings.Contains(w.Body.String(), "shared preset") {
		t.Errorf("other group sees shared preset: %s", w.Body.String())
	}

	// Admin sees everything.
	w = doRequest(handler, "GET", "/api/v1/presets", tokenFor(t, "admin@test.com"), nil)
	if !strings.Contains(w.Body.String(), "shared preset") || !strings.Contains(w.Body.String(), "private preset") {
		t.Errorf("admin presets = %s", w.Body.String())
	}
}

func TestPresetManagePermissions(t *testing.T) {
	handler := setupPresetTest(t)
	profToken := tokenFor(t, "professor@test.com")
	groupA := groupIDByName(t, "group-a")
	groupB := groupIDByName(t, "group-b")

	w := doRequest(handler, "POST", "/api/v1/presets", profToken, presetPayload("group config", "group", 9))
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var preset model.BenchmarkPreset
	json.Unmarshal(w.Body.Bytes(), &preset)

	// PhD cannot manage it.
	phdToken := tokenFor(t, "phd@test.com")
	w = doRequest(handler, "PUT", "/api/v1/presets/"+preset.ID.String(), phdToken, map[string]any{"name": "hacked"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("phd update = %d, want 403", w.Code)
	}

	// A professor of the same group can manage the shared preset, but cannot
	// change its visibility.
	peerEmail := fmt.Sprintf("peer-prof-%d@test.com", time.Now().UnixNano())
	createTestUser(t, peerEmail, model.RoleProfessor, &groupA)
	peerToken := tokenFor(t, peerEmail)
	w = doRequest(handler, "PUT", "/api/v1/presets/"+preset.ID.String(), peerToken,
		map[string]any{"name": "renamed by peer", "visibility": "private"})
	if w.Code != http.StatusOK {
		t.Fatalf("peer update = %d: %s", w.Code, w.Body.String())
	}
	var updated model.BenchmarkPreset
	json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.Visibility != "group" {
		t.Errorf("professor changed visibility to %q despite not owning the preset", updated.Visibility)
	}

	// A professor of another group cannot manage it.
	otherProfEmail := fmt.Sprintf("prof-b-%d@test.com", time.Now().UnixNano())
	createTestUser(t, otherProfEmail, model.RoleProfessor, &groupB)
	otherToken := tokenFor(t, otherProfEmail)
	w = doRequest(handler, "DELETE", "/api/v1/presets/"+preset.ID.String(), otherToken, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("other group delete = %d, want 403", w.Code)
	}

	// Admin can delete it.
	w = doRequest(handler, "DELETE", "/api/v1/presets/"+preset.ID.String(), tokenFor(t, "admin@test.com"), nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("admin delete = %d, want 204", w.Code)
	}
}

func TestConfigHistoryRecorded(t *testing.T) {
	handler := setupPresetTest(t)
	token := tokenFor(t, "user@test.com")

	// Older tests create benchmarks with the same account: start clean.
	if _, err := testDB.Exec(context.Background(),
		`DELETE FROM benchmark_config_history WHERE user_id = (SELECT id FROM users WHERE email = 'user@test.com')`); err != nil {
		t.Fatalf("clear history: %v", err)
	}

	upload := func(level int, name string) {
		w := doCreateBenchmarkWithCompressors(handler, token, name, map[string][]byte{
			name + ".bin": sampleBinBytes(t, 16),
		}, fmt.Sprintf(`[{"name":"gzip","options":{"level":%d}}]`, level))
		if w.Code != http.StatusCreated {
			t.Fatalf("create benchmark = %d: %s", w.Code, w.Body.String())
		}
	}

	upload(9, "first")
	upload(9, "second") // same configuration: history stays deduplicated
	w := doRequest(handler, "GET", "/api/v1/config-history", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("history = %d: %s", w.Code, w.Body.String())
	}
	var entries []model.BenchmarkConfigHistory
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("history entries = %d, want 1 (deduplicated)", len(entries))
	}
	if entries[0].Compressors[0].Label != "gzip · level 9" {
		t.Errorf("history label = %q", entries[0].Compressors[0].Label)
	}

	upload(1, "third")
	w = doRequest(handler, "GET", "/api/v1/config-history", token, nil)
	json.Unmarshal(w.Body.Bytes(), &entries)
	if len(entries) != 2 {
		t.Fatalf("history entries = %d, want 2", len(entries))
	}
	if entries[0].Compressors[0].Options["level"] != float64(1) {
		t.Errorf("most recent entry = %+v", entries[0].Compressors[0])
	}
}
