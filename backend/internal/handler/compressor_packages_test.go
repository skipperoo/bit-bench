//go:build integration

package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/skipperoo/routy"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/runner"
	"bitbench/internal/service"
)

type fakeRunner struct {
	result *runner.Result
	err    error
}

func (f *fakeRunner) Run(_ context.Context, _ runner.Spec) (*runner.Result, error) {
	return f.result, f.err
}

func setupPackageTest(t *testing.T) (http.Handler, *fakeRunner) {
	t.Helper()

	cfg := &config.Config{
		JWTSecret:        "test-secret",
		JWTExpiry:        1 * time.Hour,
		MaxParallelism:   2,
		CompressorDir:    t.TempDir(),
		MaxPackageSizeMB: 10,
		MaxRunnerWorkers: 8,
		BuildTimeout:     30 * time.Second,
	}
	model.InitJWT(cfg.JWTSecret)
	service.InitServices(cfg, testDB, testRDB)
	service.InitRepos(testDB)
	middleware.InitAuthMiddleware(testRDB)
	middleware.InitUserResolver(service.UserRepo)

	fake := &fakeRunner{result: &runner.Result{ExitCode: 0, Logs: "build ok"}}
	service.App.Compressor.SetRunner(fake)

	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("GET /compressors", ListCompressors).
		AddHandler("POST /compressors/packages", middleware.RequireUploader(UploadCompressorPackage)).
		AddHandler("GET /compressors/packages", ListCompressorPackages).
		AddHandler("GET /compressors/packages/{id}", GetCompressorPackage).
		AddHandler("DELETE /compressors/packages/{id}", DeleteCompressorPackage)

	router := routy.NewRouter()
	router.AddSubroute("/api/v1/", protected.Finalize())
	return router.Finalize(), fake
}

func makePackageZip(t *testing.T, name, entrypoint string) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	spec := fmt.Sprintf("name: %s\nversion: \"1.0.0\"\nentrypoint: %s\noptions:\n  level:\n    type: number\n    min: 1\n    max: 9\n    default: 6\n", name, entrypoint)
	specHdr := &zip.FileHeader{Name: "spec.yaml", Method: zip.Deflate}
	specHdr.SetMode(0644)
	w, _ := zw.CreateHeader(specHdr)
	w.Write([]byte(spec))

	scriptHdr := &zip.FileHeader{Name: "run.sh", Method: zip.Deflate}
	scriptHdr.SetMode(0755)
	w, _ = zw.CreateHeader(scriptHdr)
	w.Write([]byte("#!/bin/sh\nexit 0\n"))

	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func doMultipart(handler http.Handler, path, token, filename string, content []byte) *httptest.ResponseRecorder {
	body := new(bytes.Buffer)
	mw := multipart.NewWriter(body)
	fw, _ := mw.CreateFormFile("file", filename)
	fw.Write(content)
	mw.Close()

	r := httptest.NewRequest("POST", path, body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func waitPackageStatus(t *testing.T, handler http.Handler, token, id, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		w := doRequest(handler, "GET", "/api/v1/compressors/packages/"+id, token, nil)
		if w.Code == http.StatusOK {
			var pkg map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &pkg); err == nil && pkg["status"] == want {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("package %s did not reach status %q", id, want)
}

func TestUploadPackageHappyPath(t *testing.T) {
	handler, _ := setupPackageTest(t)
	token := tokenFor(t, "professor@test.com")
	groupA := groupIDByName(t, "group-a")

	w := doMultipart(handler, "/api/v1/compressors/packages", token, "codec-a.zip", makePackageZip(t, "codec_a", "./run.sh"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}

	var pkg model.CompressorPackage
	if err := json.Unmarshal(w.Body.Bytes(), &pkg); err != nil {
		t.Fatalf("decode package: %v", err)
	}
	if pkg.GroupID == nil || *pkg.GroupID != groupA {
		t.Errorf("group = %v, want professor's group", pkg.GroupID)
	}
	if pkg.Name != "codec_a" || pkg.Workers != 1 {
		t.Errorf("unexpected package: %+v", pkg)
	}

	waitPackageStatus(t, handler, token, pkg.ID.String(), "ready")
}

func TestUploadPackageForbiddenForStudent(t *testing.T) {
	handler, _ := setupPackageTest(t)

	w := doMultipart(handler, "/api/v1/compressors/packages", tokenFor(t, "user@test.com"), "codec.zip", makePackageZip(t, "codec_student", "./run.sh"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("student upload = %d, want 403", w.Code)
	}
}

func TestUploadPackageRejectsBuiltinName(t *testing.T) {
	handler, _ := setupPackageTest(t)
	token := tokenFor(t, "professor@test.com")

	w := doMultipart(handler, "/api/v1/compressors/packages", token, "codec.zip", makePackageZip(t, "gzip", "./run.sh"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("builtin name upload = %d, want 400: %s", w.Code, w.Body.String())
	}
}

func TestUploadPackageRejectsMissingSpec(t *testing.T) {
	handler, _ := setupPackageTest(t)
	token := tokenFor(t, "professor@test.com")

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hdr := &zip.FileHeader{Name: "readme.txt", Method: zip.Deflate}
	hdr.SetMode(0644)
	entry, _ := zw.CreateHeader(hdr)
	entry.Write([]byte("no spec here"))
	zw.Close()

	w := doMultipart(handler, "/api/v1/compressors/packages", token, "codec.zip", buf.Bytes())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing spec upload = %d, want 400", w.Code)
	}
}

func TestPackageVisibility(t *testing.T) {
	handler, _ := setupPackageTest(t)
	profToken := tokenFor(t, "professor@test.com")

	w := doMultipart(handler, "/api/v1/compressors/packages", profToken, "codec.zip", makePackageZip(t, "codec_visible", "./run.sh"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}

	// Same group (phd) sees it; other group (student) does not; admin does.
	phd := doRequest(handler, "GET", "/api/v1/compressors/packages", tokenFor(t, "phd@test.com"), nil)
	if phd.Code != http.StatusOK || !bytes.Contains(phd.Body.Bytes(), []byte("codec_visible")) {
		t.Errorf("phd should see group package: %d %s", phd.Code, phd.Body.String())
	}
	outsider := doRequest(handler, "GET", "/api/v1/compressors/packages", tokenFor(t, "other@test.com"), nil)
	if outsider.Code != http.StatusOK || bytes.Contains(outsider.Body.Bytes(), []byte("codec_visible")) {
		t.Errorf("other-group user should not see package: %s", outsider.Body.String())
	}
	admin := doRequest(handler, "GET", "/api/v1/compressors/packages", tokenFor(t, "admin@test.com"), nil)
	if admin.Code != http.StatusOK || !bytes.Contains(admin.Body.Bytes(), []byte("codec_visible")) {
		t.Errorf("admin should see package: %d", admin.Code)
	}
}

func TestPackageReplaceOnlyByOwner(t *testing.T) {
	handler, _ := setupPackageTest(t)
	profToken := tokenFor(t, "professor@test.com")
	phdToken := tokenFor(t, "phd@test.com")

	first := doMultipart(handler, "/api/v1/compressors/packages", profToken, "codec.zip", makePackageZip(t, "codec_replace", "./run.sh"))
	if first.Code != http.StatusAccepted {
		t.Fatalf("first upload = %d: %s", first.Code, first.Body.String())
	}
	var pkg model.CompressorPackage
	json.Unmarshal(first.Body.Bytes(), &pkg)

	second := doMultipart(handler, "/api/v1/compressors/packages", profToken, "codec.zip", makePackageZip(t, "codec_replace", "./run.sh"))
	if second.Code != http.StatusAccepted {
		t.Fatalf("replace upload = %d: %s", second.Code, second.Body.String())
	}
	var replaced model.CompressorPackage
	json.Unmarshal(second.Body.Bytes(), &replaced)
	if replaced.ID != pkg.ID {
		t.Errorf("replace changed id: %s -> %s", pkg.ID, replaced.ID)
	}

	// Another user cannot take the name.
	taken := doMultipart(handler, "/api/v1/compressors/packages", phdToken, "codec.zip", makePackageZip(t, "codec_replace", "./run.sh"))
	if taken.Code != http.StatusConflict {
		t.Fatalf("non-owner replace = %d, want 409: %s", taken.Code, taken.Body.String())
	}
}

func TestPackageDeletePermissions(t *testing.T) {
	handler, _ := setupPackageTest(t)
	profToken := tokenFor(t, "professor@test.com")

	w := doMultipart(handler, "/api/v1/compressors/packages", profToken, "codec.zip", makePackageZip(t, "codec_delete", "./run.sh"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	var pkg model.CompressorPackage
	json.Unmarshal(w.Body.Bytes(), &pkg)

	// Other-group professor cannot delete.
	otherProfToken := createOtherGroupProfessor(t)
	denied := doRequest(handler, "DELETE", "/api/v1/compressors/packages/"+pkg.ID.String(), otherProfToken, nil)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("outsider delete = %d, want 403", denied.Code)
	}

	// Admin can delete.
	deleted := doRequest(handler, "DELETE", "/api/v1/compressors/packages/"+pkg.ID.String(), tokenFor(t, "admin@test.com"), nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("admin delete = %d, want 204: %s", deleted.Code, deleted.Body.String())
	}
}

func createOtherGroupProfessor(t *testing.T) string {
	t.Helper()
	groupB := groupIDByName(t, "group-b")
	email := fmt.Sprintf("prof-b-%d@test.com", time.Now().UnixNano())
	createTestUser(t, email, model.RoleProfessor, &groupB)
	return tokenFor(t, email)
}

func TestCompressorsMergedIncludesCustom(t *testing.T) {
	handler, _ := setupPackageTest(t)
	token := tokenFor(t, "professor@test.com")

	w := doMultipart(handler, "/api/v1/compressors/packages", token, "codec.zip", makePackageZip(t, "codec_merged", "./run.sh"))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	var pkg model.CompressorPackage
	json.Unmarshal(w.Body.Bytes(), &pkg)
	waitPackageStatus(t, handler, token, pkg.ID.String(), "ready")

	w = doRequest(handler, "GET", "/api/v1/compressors", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list compressors = %d", w.Code)
	}
	var merged map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &merged); err != nil {
		t.Fatalf("decode compressors: %v", err)
	}
	if _, ok := merged["gzip"]; !ok {
		t.Error("built-in gzip missing from merged map")
	}
	custom, ok := merged["codec_merged"]
	if !ok {
		t.Fatalf("custom compressor missing from merged map: %v", merged)
	}
	if _, ok := custom["level"]; !ok {
		t.Errorf("custom options missing: %v", custom)
	}
}
