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

	"github.com/skipperoo/routy"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
)

func TestExperimentsListFiltersDeleteCancel(t *testing.T) {
	_ = setupBenchmarkTest(t)
	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST /benchmarks", CreateBenchmark).
		AddHandler("GET /benchmarks", ListBenchmarks).
		AddHandler("DELETE /benchmarks/{id}", DeleteBenchmark).
		AddHandler("POST /benchmarks/{id}/cancel", CancelBenchmark).
		AddHandler("GET /benchmarks/{id}/tasks", ListBenchmarkTasks)
	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	handler := router.Finalize()

	createTestUser(t, "exp@test.com", model.RoleStudent, nil)
	createTestUser(t, "other-exp@test.com", model.RoleStudent, nil)
	t.Cleanup(func() {
		testDB.Exec(context.Background(), `DELETE FROM users WHERE email IN ('exp@test.com','other-exp@test.com')`)
	})
	token := tokenFor(t, "exp@test.com")
	other := tokenFor(t, "other-exp@test.com")

	// Separate upload: three benchmarks sharing one experiment.
	body := new(bytes.Buffer)
	mw := multipart.NewWriter(body)
	mw.WriteField("name", "sep")
	mw.WriteField("mode", "separate")
	mw.WriteField("compressors", `[{"name":"zstd","options":{}}]`)
	for _, f := range []string{"a.bin", "b.bin", "c.bin"} {
		fw, _ := mw.CreateFormFile("files", f)
		fw.Write(sampleBinBytes(t, 8))
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/v1/benchmarks", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var sep struct{ Benchmarks []model.Benchmark }
	json.Unmarshal(rec.Body.Bytes(), &sep)
	if len(sep.Benchmarks) != 3 || sep.Benchmarks[0].ExperimentID != sep.Benchmarks[2].ExperimentID || sep.Benchmarks[0].ExperimentID == sep.Benchmarks[0].ID {
		t.Fatalf("separate upload must share one experiment: %s", rec.Body.String())
	}
	// A plain upload is its own experiment.
	w := doCreateBenchmarkWithCompressors(handler, token, "single", map[string][]byte{"x.bin": sampleBinBytes(t, 8)}, `[{"name":"gzip","options":{}}]`)
	var single model.Benchmark
	json.Unmarshal(w.Body.Bytes(), &single)
	if single.ExperimentID != single.ID {
		t.Fatalf("single upload experiment = %s, id = %s", single.ExperimentID, single.ID)
	}

	list := func(query string) []model.Benchmark {
		w := getWithToken(handler, "/api/v1/benchmarks?"+query, token)
		var resp struct{ Benchmarks []model.Benchmark }
		json.Unmarshal(w.Body.Bytes(), &resp)
		return resp.Benchmarks
	}
	if got := list("compressor=zstd"); len(got) != 3 {
		t.Errorf("compressor filter: %d, want 3", len(got))
	}
	if got := list("source=upload&status=queued,in_progress"); len(got) != 4 {
		t.Errorf("source+multi-status filter: %d, want 4", len(got))
	}
	if got := list("source=dataset"); len(got) != 0 {
		t.Errorf("dataset filter: %d, want 0", len(got))
	}

	// The live view lists the queued task without its result payload.
	path := "/api/v1/benchmarks/" + single.ID.String()
	tw := getWithToken(handler, path+"/tasks", token)
	var tasks struct {
		Tasks []map[string]interface{} `json:"tasks"`
	}
	json.Unmarshal(tw.Body.Bytes(), &tasks)
	if tw.Code != http.StatusOK || len(tasks.Tasks) != 1 || tasks.Tasks[0]["status"] != "queued" || tasks.Tasks[0]["input"] != "x.bin" {
		t.Fatalf("tasks = %d %s", tw.Code, tw.Body.String())
	}
	if _, leaked := tasks.Tasks[0]["result"]; leaked {
		t.Fatal("task result payload must not be exposed")
	}
	if w := getWithToken(handler, path+"/tasks", other); w.Code != http.StatusNotFound {
		t.Fatalf("foreign tasks = %d, want 404", w.Code)
	}

	// Only the owner may cancel/delete; cancel works once.
	r := httptest.NewRequest("POST", path+"/cancel", nil)
	r.Header.Set("Authorization", "Bearer "+other)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign cancel = %d, want 404", rec.Code)
	}
	for i, want := range []int{http.StatusOK, http.StatusConflict} {
		r = httptest.NewRequest("POST", path+"/cancel", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		if rec.Code != want {
			t.Fatalf("cancel #%d = %d, want %d", i+1, rec.Code, want)
		}
	}
	r = httptest.NewRequest("DELETE", path, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != http.StatusNoContent || len(list("q=single")) != 0 {
		t.Fatalf("delete = %d", rec.Code)
	}
}
