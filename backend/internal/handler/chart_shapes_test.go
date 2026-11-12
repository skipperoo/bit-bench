//go:build integration

package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/skipperoo/routy"

	"bitbench/internal/middleware"
)

func setupChartShapesTest(t *testing.T) http.Handler {
	t.Helper()
	setupPresetTest(t) // services, repos, JWT and user resolver
	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("GET /me/chart-shapes", GetChartShapes).
		AddHandler("PUT /me/chart-shapes", PutChartShapes)
	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize()
}

func getShapes(t *testing.T, h http.Handler, token string) map[string]string {
	t.Helper()
	w := doRequest(h, "GET", "/api/v1/me/chart-shapes", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Shapes map[string]string `json:"shapes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Shapes == nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return body.Shapes
}

func TestChartShapesPerUser(t *testing.T) {
	h := setupChartShapesTest(t)
	student := tokenFor(t, "user@test.com")
	phd := tokenFor(t, "phd@test.com")

	// Defaults: no overrides.
	if s := getShapes(t, h, student); len(s) != 0 {
		t.Fatalf("initial overrides = %v", s)
	}

	w := doRequest(h, "PUT", "/api/v1/me/chart-shapes", student, map[string]any{
		"shapes": map[string]string{"Gorilla": "hexagon", "gzip · level 9": "x"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("put = %d: %s", w.Code, w.Body.String())
	}
	if s := getShapes(t, h, student); s["Gorilla"] != "hexagon" || s["gzip · level 9"] != "x" || len(s) != 2 {
		t.Errorf("saved overrides = %v", s)
	}
	// Overrides are private to the user.
	if s := getShapes(t, h, phd); len(s) != 0 {
		t.Errorf("other user sees overrides: %v", s)
	}

	// An empty map restores the defaults.
	if w := doRequest(h, "PUT", "/api/v1/me/chart-shapes", student, map[string]any{"shapes": map[string]string{}}); w.Code != http.StatusOK {
		t.Fatalf("reset = %d: %s", w.Code, w.Body.String())
	}
	if s := getShapes(t, h, student); len(s) != 0 {
		t.Errorf("after reset = %v", s)
	}
}

func TestChartShapesRejectsInvalid(t *testing.T) {
	h := setupChartShapesTest(t)
	token := tokenFor(t, "user@test.com")

	if w := doRequest(h, "PUT", "/api/v1/me/chart-shapes", token, map[string]any{"shapes": map[string]string{"Gorilla": "blob"}}); w.Code != http.StatusBadRequest {
		t.Errorf("unknown shape = %d, want 400", w.Code)
	}
	if w := doRequest(h, "PUT", "/api/v1/me/chart-shapes", token, "not an object"); w.Code != http.StatusBadRequest {
		t.Errorf("bad body = %d, want 400", w.Code)
	}
	if w := doRequest(h, "GET", "/api/v1/me/chart-shapes", "", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", w.Code)
	}
	if s := getShapes(t, h, token); len(s) != 0 {
		t.Errorf("invalid request changed overrides: %v", s)
	}
}
