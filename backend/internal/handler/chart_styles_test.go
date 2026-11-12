//go:build integration

package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/skipperoo/routy"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
)

func setupChartStylesTest(t *testing.T) http.Handler {
	t.Helper()
	setupPresetTest(t) // services, repos, JWT and user resolver
	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("GET /me/chart-styles", GetChartStyles).
		AddHandler("PUT /me/chart-styles", PutChartStyles)
	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize()
}

func getStyles(t *testing.T, h http.Handler, token string) model.ChartStyles {
	t.Helper()
	w := doRequest(h, "GET", "/api/v1/me/chart-styles", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d: %s", w.Code, w.Body.String())
	}
	var s model.ChartStyles
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil || s.Shapes == nil || s.Colors == nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return s
}

func TestChartStylesPerUser(t *testing.T) {
	h := setupChartStylesTest(t)
	student := tokenFor(t, "user@test.com")
	phd := tokenFor(t, "phd@test.com")

	// Start from the defaults (the test database is shared between tests).
	if w := doRequest(h, "PUT", "/api/v1/me/chart-styles", student, map[string]any{}); w.Code != http.StatusOK {
		t.Fatalf("reset = %d: %s", w.Code, w.Body.String())
	}
	if s := getStyles(t, h, student); len(s.Shapes)+len(s.Colors) != 0 {
		t.Fatalf("initial overrides = %+v", s)
	}

	w := doRequest(h, "PUT", "/api/v1/me/chart-styles", student, map[string]any{
		"shapes": map[string]string{"gorilla": "hexagon"},
		"colors": map[string]string{"gorilla": "#D62728", "gzip · level 9": "#2ca02c"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("put = %d: %s", w.Code, w.Body.String())
	}
	s := getStyles(t, h, student)
	if s.Shapes["gorilla"] != "hexagon" || s.Colors["gorilla"] != "#d62728" || s.Colors["gzip · level 9"] != "#2ca02c" {
		t.Errorf("saved overrides = %+v", s)
	}
	if o := getStyles(t, h, phd); len(o.Shapes)+len(o.Colors) != 0 {
		t.Errorf("other user sees overrides: %+v", o)
	}

	// Omitted maps are cleared: the body replaces both.
	if w := doRequest(h, "PUT", "/api/v1/me/chart-styles", student, map[string]any{"shapes": map[string]string{"gzip": "x"}}); w.Code != http.StatusOK {
		t.Fatalf("replace = %d: %s", w.Code, w.Body.String())
	}
	if s := getStyles(t, h, student); s.Shapes["gzip"] != "x" || len(s.Shapes) != 1 || len(s.Colors) != 0 {
		t.Errorf("after replace = %+v", s)
	}
}

func TestChartStylesRejectsInvalid(t *testing.T) {
	h := setupChartStylesTest(t)
	token := tokenFor(t, "user@test.com")
	// Known starting state (the test database is shared between tests).
	if w := doRequest(h, "PUT", "/api/v1/me/chart-styles", token, map[string]any{"colors": map[string]string{"zstd": "#123456"}}); w.Code != http.StatusOK {
		t.Fatalf("seed = %d: %s", w.Code, w.Body.String())
	}

	for _, body := range []any{
		map[string]any{"shapes": map[string]string{"gorilla": "blob"}},
		map[string]any{"colors": map[string]string{"gorilla": "red"}},
		"not an object",
	} {
		if w := doRequest(h, "PUT", "/api/v1/me/chart-styles", token, body); w.Code != http.StatusBadRequest {
			t.Errorf("%v = %d, want 400", body, w.Code)
		}
	}
	if w := doRequest(h, "GET", "/api/v1/me/chart-styles", "", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", w.Code)
	}
	if s := getStyles(t, h, token); len(s.Shapes) != 0 || len(s.Colors) != 1 || s.Colors["zstd"] != "#123456" {
		t.Errorf("invalid request changed overrides: %+v", s)
	}
}
