//go:build integration

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/skipperoo/routy"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
)

func TestUploadRateLimitAndSeparateMode(t *testing.T) {
	_ = setupBenchmarkTest(t)
	testRDB.FlushDB(context.Background())
	limiter := middleware.NewRateLimiter(testRDB, 2, time.Minute, middleware.UserKeyFunc).WithPrefix("upload:")
	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST /benchmarks", limiter.Wrap(CreateBenchmark))
	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	handler := router.Finalize()
	token := tokenFor(t, "user@test.com")

	// One request, three files, mode=separate -> three benchmarks.
	body := new(bytes.Buffer)
	mw := multipart.NewWriter(body)
	mw.WriteField("name", "sep")
	mw.WriteField("mode", "separate")
	mw.WriteField("compressors", `[{"name":"gzip","options":{}}]`)
	for _, f := range []string{"a.bin", "b.bin", "c.bin"} {
		fw, _ := mw.CreateFormFile("files", f)
		fw.Write(sampleBinBytes(t, 8))
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/v1/benchmarks", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("separate upload = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Benchmarks []model.Benchmark `json:"benchmarks"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Benchmarks) != 3 || resp.Benchmarks[0].FileCount != 1 || resp.Benchmarks[0].Name != "sep (a)" {
		t.Fatalf("got %d benchmarks: %s", len(resp.Benchmarks), w.Body.String())
	}

	// Second request is allowed, the third exceeds the limit of 2/min.
	if w := doCreateBenchmark(handler, token, "two", map[string][]byte{"a.bin": sampleBinBytes(t, 8)}); w.Code != http.StatusCreated {
		t.Fatalf("second upload = %d", w.Code)
	}
	w = doCreateBenchmark(handler, token, "three", map[string][]byte{"a.bin": sampleBinBytes(t, 8)})
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("third upload = %d (Retry-After %q), want 429", w.Code, w.Header().Get("Retry-After"))
	}
	var errBody map[string]string
	if json.Unmarshal(w.Body.Bytes(), &errBody) != nil || errBody["error"] == "" {
		t.Fatalf("429 body must be a JSON error: %s", w.Body.String())
	}
}
