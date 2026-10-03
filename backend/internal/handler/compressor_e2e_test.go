//go:build integration

package handler

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"bitbench/internal/runner"
	"bitbench/internal/service"
)

const e2eRunnerImage = "bitbench-runner:e2e"

func e2eCCompilerPackage(t *testing.T) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	add := func(name, content string, mode os.FileMode) {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		hdr.SetMode(mode)
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatalf("zip entry %s: %v", name, err)
		}
		w.Write([]byte(content))
	}

	add("spec.yaml", "name: e2e_hello\nversion: \"1.0.0\"\nentrypoint: ./hello\nbuild:\n  command: make\n", 0644)
	add("Makefile", "hello: hello.c\n\tgcc -O2 -o hello hello.c\n", 0644)
	add("hello.c", "#include <stdio.h>\nint main(void){printf(\"hello\\n\");return 0;}\n", 0644)

	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

// TestCompressorPackageE2E builds the real runner image (if needed) and
// compiles a C package inside a sandboxed container.
func TestCompressorPackageE2E(t *testing.T) {
	dockerRunner, err := runner.NewDockerRunner(e2eRunnerImage, 2048, 256)
	if err != nil {
		t.Skipf("docker unavailable, skipping E2E: %v", err)
	}
	defer dockerRunner.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	if err := dockerRunner.Ping(ctx); err != nil {
		runnerDir := filepath.Join("..", "..", "..", "runner")
		t.Logf("building runner image from %s (this can take a few minutes)", runnerDir)
		logs, err := dockerRunner.BuildImage(ctx, runnerDir, e2eRunnerImage)
		if err != nil {
			t.Fatalf("build runner image: %v\n%s", err, logs)
		}
	}

	handler, _ := setupPackageTest(t)
	service.App.Compressor.SetRunner(dockerRunner)

	token := tokenFor(t, "professor@test.com")
	w := doMultipart(handler, "/api/v1/compressors/packages", token, "e2e.zip", e2eCCompilerPackage(t))
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	var pkg struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &pkg); err != nil {
		t.Fatalf("decode package: %v", err)
	}

	waitPackageStatus(t, handler, token, pkg.ID, "ready")
}
