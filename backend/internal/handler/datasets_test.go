//go:build integration

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/skipperoo/routy"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/seqfile"
	"bitbench/internal/service"
)

func setupDatasetTest(t *testing.T) (http.Handler, *config.Config) {
	t.Helper()
	cfg := &config.Config{
		JWTSecret:      "test-secret",
		JWTExpiry:      time.Hour,
		MaxParallelism: 4,
		MaxFileSizeMB:  10,
		DataDir:        t.TempDir(),
		DatasetDir:     t.TempDir(),
	}
	model.InitJWT(cfg.JWTSecret)
	InitHandlers(cfg)
	service.InitServices(cfg, testDB, testRDB)
	service.InitRepos(testDB)
	middleware.InitAuthMiddleware(testRDB)
	middleware.InitUserResolver(service.UserRepo)

	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("GET /datasets", ListDatasets).
		AddHandler("GET /datasets/{dataset}/series/{series}/preview", PreviewDatasetSeries).
		AddHandler("POST /benchmarks/dataset", CreateDatasetBenchmarks)
	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize(), cfg
}

func TestDatasetListAndRun(t *testing.T) {
	handler, cfg := setupDatasetTest(t)
	token := tokenFor(t, "user@test.com")

	dir := filepath.Join(cfg.DatasetDir, "finance")
	os.MkdirAll(dir, 0755)
	values := make([]int64, 1000)
	for i := range values {
		values[i] = int64(10000 + i%7)
	}
	if err := seqfile.WriteBinFile(filepath.Join(dir, "NVDA.bin"), values, 2); err != nil {
		t.Fatal(err)
	}
	seqfile.WriteBinFile(filepath.Join(dir, "TINY.bin"), values[:50], 2)

	w := getWithToken(handler, "/api/v1/datasets", token)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", w.Code, w.Body.String())
	}
	var list struct {
		Datasets []struct {
			Name   string `json:"name"`
			Series []struct {
				Name   string `json:"name"`
				Values uint64 `json:"values"`
			} `json:"series"`
		} `json:"datasets"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Datasets) != 1 || len(list.Datasets[0].Series) != 2 {
		t.Fatalf("unexpected listing %s", w.Body.String())
	}

	pw := getWithToken(handler, "/api/v1/datasets/finance/series/NVDA/preview", token)
	var preview struct {
		Values    uint64 `json:"values"`
		Min, Max  int64
		Sparkline [][2]int64 `json:"sparkline"`
	}
	json.Unmarshal(pw.Body.Bytes(), &preview)
	if pw.Code != http.StatusOK || preview.Values != 1000 || preview.Min != 10000 || preview.Max != 10006 || len(preview.Sparkline) == 0 {
		t.Fatalf("preview = %d %s", pw.Code, pw.Body.String())
	}
	if w := getWithToken(handler, "/api/v1/datasets/finance/series/nope/preview", token); w.Code != http.StatusNotFound {
		t.Fatalf("missing series preview = %d, want 404", w.Code)
	}

	body, _ := json.Marshal(map[string]interface{}{
		"name":        "fin",
		"dataset":     "finance",
		"chunk_sizes": []int{0, 100},
		"max_chunks":  4,
		"transforms":  []string{"gap"},
		"aggregation": "pooled",
		"compressors": []map[string]interface{}{{"name": "gzip", "options": map[string]interface{}{}}},
	})
	r := httptest.NewRequest("POST", "/api/v1/benchmarks/dataset", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != http.StatusCreated {
		t.Fatalf("run = %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Benchmarks []model.Benchmark `json:"benchmarks"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Benchmarks) != 2 {
		t.Fatalf("got %d benchmarks, want 2 (whole + 100-sample chunks)", len(resp.Benchmarks))
	}

	whole, chunked := resp.Benchmarks[0], resp.Benchmarks[1]
	if whole.Name != "fin · gap · whole" || whole.Source == nil || whole.Source.Inputs != 2 || whole.Aggregation != "pooled" {
		t.Errorf("whole-series benchmark = %+v (source %+v)", whole, whole.Source)
	}
	// NVDA: min(10, 4) chunks; TINY is shorter than one chunk and skipped.
	if chunked.Source == nil || chunked.Source.Inputs != 4 || len(chunked.Warnings) != 1 {
		t.Errorf("chunked benchmark = %+v (source %+v)", chunked, chunked.Source)
	}

	var tasks int
	testDB.QueryRow(context.Background(), `SELECT COUNT(*) FROM benchmark_tasks WHERE benchmark_id = $1`, chunked.ID).Scan(&tasks)
	if tasks != 4 {
		t.Errorf("tasks = %d, want one built-in task per chunk", tasks)
	}
	stored, err := service.BenchRepo.FindByID(context.Background(), chunked.ID)
	if err != nil || stored.Source == nil || stored.Source.Transform != "gap" || stored.Source.ChunkSize != 100 {
		t.Errorf("source not persisted: %+v %v", stored, err)
	}

	// Validation errors are reported as 400.
	bad, _ := json.Marshal(map[string]interface{}{"dataset": "finance", "transforms": []string{"zigzag"},
		"compressors": []map[string]interface{}{{"name": "gzip"}}})
	r = httptest.NewRequest("POST", "/api/v1/benchmarks/dataset", bytes.NewReader(bad))
	r.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("invalid transform = %d, want 400", rec.Code)
	}
}
