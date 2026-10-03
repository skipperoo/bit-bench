//go:build integration

package worker

import (
	"archive/zip"
	"context"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"bitbench/internal/config"
	"bitbench/internal/logger"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/runner"
	"bitbench/internal/service"
)

const e2eRunnerImage = "bitbench-runner:e2e"

var testDB *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	logger.InitLogger()
	defer logger.CloseLogger()

	pgC, err := postgres.Run(ctx,
		"postgres:18-alpine",
		postgres.WithDatabase("bitbench_worker_test"),
		postgres.WithUsername("bitbench"),
		postgres.WithPassword("testpass"),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to start postgres: %v\n", err)
		os.Exit(1)
	}

	connStr, err := pgC.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to get conn string: %v\n", err)
		os.Exit(1)
	}
	testDB, err = pgxpool.New(ctx, connStr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to connect: %v\n", err)
		os.Exit(1)
	}

	if err := config.RunMigrations(ctx, testDB); err != nil {
		fmt.Fprintf(os.Stderr, "migrations failed: %v\n", err)
		os.Exit(1)
	}
	testDB.Exec(ctx, `INSERT INTO groups (name, priority) VALUES ('e2e', 0)`)
	testDB.Exec(ctx, `INSERT INTO users (email, password_hash, role) VALUES ('e2e@test.com', 'x', 'professor')`)

	code := m.Run()
	testDB.Close()
	pgC.Terminate(ctx)
	os.Exit(code)
}

func e2eUser(t *testing.T) *model.User {
	t.Helper()
	user := &model.User{}
	var groupID uuid.UUID
	if err := testDB.QueryRow(context.Background(),
		`SELECT u.id, g.id FROM users u JOIN groups g ON g.name = 'e2e' WHERE u.email = 'e2e@test.com'`,
	).Scan(&user.ID, &groupID); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	user.Role = model.RoleProfessor
	user.GroupID = &groupID
	return user
}

func buildImageIfMissing(t *testing.T, d *runner.DockerRunner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := d.Ping(ctx); err != nil {
		runnerDir := filepath.Join("..", "..", "..", "runner")
		logs, err := d.BuildImage(ctx, runnerDir, e2eRunnerImage)
		if err != nil {
			t.Fatalf("build runner image: %v\n%s", err, logs)
		}
	}
}

func zipDirectory(t *testing.T, dir string) string {
	t.Helper()

	outPath := filepath.Join(t.TempDir(), "package.zip")
	out, err := os.Create(outPath)
	if err != nil {
		t.Fatalf("create zip: %v", err)
	}
	zw := zip.NewWriter(out)

	walkErr := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		hdr := &zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate}
		hdr.SetMode(info.Mode())
		entry, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = entry.Write(data)
		return err
	})
	if walkErr != nil {
		t.Fatalf("walk %s: %v", dir, walkErr)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	out.Close()
	return outPath
}

// TestBenchmarkRunnerExamplesE2E uploads, builds and runs every example package
// (one per supported language) through the real runner image.
func TestBenchmarkRunnerExamplesE2E(t *testing.T) {
	dockerRunner, err := runner.NewDockerRunner(e2eRunnerImage, 2048, 512)
	if err != nil {
		t.Skipf("docker unavailable, skipping E2E: %v", err)
	}
	defer dockerRunner.Close()
	buildImageIfMissing(t, dockerRunner)

	ctx := context.Background()
	dataDir := t.TempDir()
	compressorDir := t.TempDir()

	cfg := &config.Config{
		DataDir:          dataDir,
		CompressorDir:    compressorDir,
		BenchBinaryPath:  "/nonexistent/LosslessBenchmarkFull",
		BenchTimeout:     180 * time.Second,
		BenchMaxRetries:  0,
		MaxRunnerWorkers: 4,
		BuildTimeout:     5 * time.Minute,
	}
	service.InitServices(cfg, testDB, nil)
	service.App.Compressor.SetRunner(dockerRunner)

	owner := e2eUser(t)

	// Input sequence: 128 values with constant delta 3 -> ratio 0.125.
	const numValues = 128
	data := make([]byte, 16+8*numValues)
	binary.LittleEndian.PutUint64(data[0:8], numValues)
	binary.LittleEndian.PutUint64(data[8:16], 0)
	for i := 0; i < numValues; i++ {
		binary.LittleEndian.PutUint64(data[16+i*8:], uint64(int64(i*3)))
	}
	sum := md5.Sum(data)
	checksum := hex.EncodeToString(sum[:])
	filename := "e2e-sample.bin"

	benchRepo := repository.NewBenchmarkRepository(testDB)
	resultRepo := repository.NewBenchmarkResultRepository(testDB)

	examples := []struct {
		dir  string
		name string
	}{
		{"python", "example_delta_py"},
		{"c", "example_delta_c"},
		{"cpp", "example_delta_cpp"},
		{"go", "example_delta_go"},
		{"rust", "example_delta_rust"},
	}

	for _, example := range examples {
		t.Run(example.name, func(t *testing.T) {
			exampleDir := filepath.Join("..", "..", "..", "examples", "user-compressors", example.dir)
			archive := zipDirectory(t, exampleDir)

			file, err := os.Open(archive)
			if err != nil {
				t.Fatalf("open archive: %v", err)
			}
			pkg, err := service.App.Compressor.UploadPackage(ctx, owner, owner.GroupID, file, example.dir+".zip")
			file.Close()
			if err != nil {
				t.Fatalf("upload package: %v", err)
			}
			if pkg.Name != example.name {
				t.Fatalf("package name = %q, want %q", pkg.Name, example.name)
			}
			if err := service.App.Compressor.Build(ctx, pkg.ID); err != nil {
				t.Fatalf("build package: %v", err)
			}

			// The runner deletes the source file after each benchmark, so it
			// must be written again for every subtest.
			if err := os.WriteFile(filepath.Join(dataDir, service.StoredFilename(filename, checksum)), data, 0644); err != nil {
				t.Fatalf("write sample: %v", err)
			}

			benchmark := &model.Benchmark{
				UserID:           owner.ID,
				Name:             "e2e " + example.name,
				OriginalFilename: filename,
				FileSize:         int64(len(data)),
				FileChecksum:     checksum,
				FileExt:          ".bin",
				Compressors:      map[string]interface{}{example.name: map[string]interface{}{}},
			}
			if err := benchRepo.Create(ctx, benchmark); err != nil {
				t.Fatalf("create benchmark: %v", err)
			}

			r := NewBenchmarkRunner(cfg, testDB, nil)
			r.SetContainerRunner(dockerRunner)
			r.executeJob(ctx, benchmark.ID)

			got, err := benchRepo.FindByID(ctx, benchmark.ID)
			if err != nil || got == nil {
				t.Fatalf("reload benchmark: %v", err)
			}
			if got.Status != "ready" {
				t.Fatalf("benchmark status = %q (error: %v), want ready", got.Status, got.Error)
			}

			results, err := resultRepo.FindByBenchmarkID(ctx, benchmark.ID)
			if err != nil {
				t.Fatalf("list results: %v", err)
			}
			if len(results) != 1 {
				t.Fatalf("results = %d, want 1", len(results))
			}
			res := results[0]
			if res.Compressor != example.name {
				t.Errorf("compressor = %q, want %q", res.Compressor, example.name)
			}
			if res.CompressionRatio == nil || *res.CompressionRatio != 0.125 {
				t.Errorf("compression_ratio = %v, want 0.125", res.CompressionRatio)
			}
			if res.MemoryUsage != nil {
				t.Errorf("memory_usage = %v, want NULL (not reported)", *res.MemoryUsage)
			}
		})
	}
}
