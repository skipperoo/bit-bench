//go:build integration

package handler

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"mime/multipart"
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

func setupBenchmarkTest(t *testing.T) http.Handler {
	t.Helper()

	cfg := &config.Config{
		JWTSecret:      "test-secret",
		JWTExpiry:      1 * time.Hour,
		MaxParallelism: 4,
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
		AddHandler("POST /benchmarks", CreateBenchmark)

	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize()
}

func sampleBinBytes(t *testing.T, count int) []byte {
	t.Helper()
	data := make([]byte, 16+8*count)
	binary.LittleEndian.PutUint64(data[0:8], uint64(count))
	for i := 0; i < count; i++ {
		binary.LittleEndian.PutUint64(data[16+i*8:], uint64(i*3))
	}
	return data
}

func doCreateBenchmark(handler http.Handler, token, name string, files map[string][]byte) *httptest.ResponseRecorder {
	body := new(bytes.Buffer)
	mw := multipart.NewWriter(body)
	mw.WriteField("name", name)
	mw.WriteField("compressors", `{"gzip":{"level":6}}`)
	// Deterministic order helps assertions.
	for filename, content := range files {
		fw, _ := mw.CreateFormFile("files", filename)
		fw.Write(content)
	}
	mw.Close()

	r := httptest.NewRequest("POST", "/api/v1/benchmarks", body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestCreateBenchmarkMultipleFiles(t *testing.T) {
	handler := setupBenchmarkTest(t)
	token := tokenFor(t, "user@test.com")

	w := doCreateBenchmark(handler, token, "multi", map[string][]byte{
		"a.bin": sampleBinBytes(t, 64),
		"b.bin": sampleBinBytes(t, 32),
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}

	var benchmark model.Benchmark
	if err := json.Unmarshal(w.Body.Bytes(), &benchmark); err != nil {
		t.Fatalf("decode benchmark: %v", err)
	}
	if benchmark.FileCount != 2 {
		t.Errorf("file_count = %d, want 2", benchmark.FileCount)
	}
	if benchmark.FileSize != int64(16+8*64+16+8*32) {
		t.Errorf("file_size = %d, want sum of both files", benchmark.FileSize)
	}

	var taskCount int
	if err := testDB.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM benchmark_tasks WHERE benchmark_id = $1 AND status = 'queued'`,
		benchmark.ID).Scan(&taskCount); err != nil {
		t.Fatalf("count tasks: %v", err)
	}
	if taskCount != 2 {
		t.Errorf("queued tasks = %d, want 2 (one built-in task per .bin)", taskCount)
	}
}

func TestCreateBenchmarkRejectsNoFiles(t *testing.T) {
	handler := setupBenchmarkTest(t)
	token := tokenFor(t, "user@test.com")

	w := doCreateBenchmark(handler, token, "empty", map[string][]byte{})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("no-files create = %d, want 400: %s", w.Code, w.Body.String())
	}
}
