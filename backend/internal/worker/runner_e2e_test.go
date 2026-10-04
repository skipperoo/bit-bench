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

func writeSampleBin(t *testing.T, dir, name string, values []int64) (string, string) {
	t.Helper()
	data := make([]byte, 16+8*len(values))
	binary.LittleEndian.PutUint64(data[0:8], uint64(len(values)))
	for i, v := range values {
		binary.LittleEndian.PutUint64(data[16+i*8:], uint64(v))
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write sample: %v", err)
	}
	sum := md5.Sum(data)
	return path, hex.EncodeToString(sum[:])
}

func uploadExamplePackage(t *testing.T, ctx context.Context, owner *model.User, dir, name string) {
	t.Helper()
	archive := zipDirectory(t, filepath.Join("..", "..", "..", "examples", "user-compressors", dir))
	file, err := os.Open(archive)
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	pkg, err := service.App.Compressor.UploadPackage(ctx, owner, owner.GroupID, file, dir+".zip")
	file.Close()
	if err != nil {
		t.Fatalf("upload package: %v", err)
	}
	if pkg.Name != name {
		t.Fatalf("package name = %q, want %q", pkg.Name, name)
	}
	if err := service.App.Compressor.Build(ctx, pkg.ID); err != nil {
		t.Fatalf("build package: %v", err)
	}
}

func waitForBenchmark(t *testing.T, ctx context.Context, benchRepo *repository.BenchmarkRepository, id uuid.UUID) *model.Benchmark {
	t.Helper()
	deadline := time.Now().Add(4 * time.Minute)
	for time.Now().Before(deadline) {
		benchmark, err := benchRepo.FindByID(ctx, id)
		if err != nil {
			t.Fatalf("load benchmark: %v", err)
		}
		switch benchmark.Status {
		case "ready", "failed", "timed_out", "cancelled":
			return benchmark
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("benchmark did not finish in time")
	return nil
}

func startScheduler(t *testing.T, cfg *config.Config, dockerRunner *runner.DockerRunner) func() {
	t.Helper()
	schedCtx, cancel := context.WithCancel(context.Background())
	r := NewBenchmarkRunner(cfg, testDB)
	r.SetContainerRunner(dockerRunner)
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.Run(schedCtx)
	}()
	return func() {
		cancel()
		<-done
	}
}

// TestBenchmarkRunnerExamplesE2E uploads, builds and runs every example package
// (one per supported language) through the real runner image and scheduler.
func TestBenchmarkRunnerExamplesE2E(t *testing.T) {
	dockerRunner, err := runner.NewDockerRunner(e2eRunnerImage, 2048, 512)
	if err != nil {
		t.Skipf("docker unavailable, skipping E2E: %v", err)
	}
	defer dockerRunner.Close()
	buildImageIfMissing(t, dockerRunner)

	ctx := context.Background()
	cfg := &config.Config{
		DataDir:         t.TempDir(),
		CompressorDir:   t.TempDir(),
		BenchBinaryPath: "/nonexistent/LosslessBenchmarkFull",
		BenchTimeout:    180 * time.Second,
		BenchMaxRetries: 0,
		MaxParallelism:  4,
		BuildTimeout:    5 * time.Minute,
	}
	service.InitServices(cfg, testDB, nil)
	service.App.Compressor.SetRunner(dockerRunner)
	owner := e2eUser(t)

	stop := startScheduler(t, cfg, dockerRunner)
	defer stop()

	benchRepo := repository.NewBenchmarkRepository(testDB)
	resultRepo := repository.NewBenchmarkResultRepository(testDB)

	// Constant delta 3 -> 1 varint byte per value -> ratio 0.125.
	values := make([]int64, 128)
	for i := range values {
		values[i] = int64(i * 3)
	}
	binPath, _ := writeSampleBin(t, t.TempDir(), "e2e.bin", values)

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
			uploadExamplePackage(t, ctx, owner, example.dir, example.name)

			file, err := os.Open(binPath)
			if err != nil {
				t.Fatal(err)
			}
			benchmark, err := service.App.Benchmark.CreateBenchmark(ctx, owner, "e2e "+example.name,
				[]service.UploadedFile{{Reader: file, Filename: "e2e.bin"}},
				map[string]interface{}{example.name: map[string]interface{}{}})
			file.Close()
			if err != nil {
				t.Fatalf("create benchmark: %v", err)
			}

			got := waitForBenchmark(t, ctx, benchRepo, benchmark.ID)
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

// TestMultiFileAveragingE2E uploads two files in one benchmark and verifies the
// parallel tasks are averaged into a single row per compressor.
func TestMultiFileAveragingE2E(t *testing.T) {
	dockerRunner, err := runner.NewDockerRunner(e2eRunnerImage, 2048, 512)
	if err != nil {
		t.Skipf("docker unavailable, skipping E2E: %v", err)
	}
	defer dockerRunner.Close()
	buildImageIfMissing(t, dockerRunner)

	ctx := context.Background()
	cfg := &config.Config{
		DataDir:         t.TempDir(),
		CompressorDir:   t.TempDir(),
		BenchBinaryPath: "/nonexistent/LosslessBenchmarkFull",
		BenchTimeout:    180 * time.Second,
		BenchMaxRetries: 0,
		MaxParallelism:  4,
		BuildTimeout:    5 * time.Minute,
	}
	service.InitServices(cfg, testDB, nil)
	service.App.Compressor.SetRunner(dockerRunner)
	owner := e2eUser(t)

	stop := startScheduler(t, cfg, dockerRunner)
	defer stop()

	uploadExamplePackage(t, ctx, owner, "python", "example_delta_py")
	benchRepo := repository.NewBenchmarkRepository(testDB)
	resultRepo := repository.NewBenchmarkResultRepository(testDB)

	// File A: delta 1 -> 1 byte/value -> 0.125. File B: delta 1000 -> 2 bytes/value -> 0.25.
	tmp := t.TempDir()
	valuesA := make([]int64, 128)
	valuesB := make([]int64, 128)
	for i := range valuesA {
		valuesA[i] = int64(i)
		valuesB[i] = int64((i + 1) * 1000)
	}
	binA, _ := writeSampleBin(t, tmp, "a.bin", valuesA)
	binB, _ := writeSampleBin(t, tmp, "b.bin", valuesB)

	fileA, _ := os.Open(binA)
	fileB, _ := os.Open(binB)
	benchmark, err := service.App.Benchmark.CreateBenchmark(ctx, owner, "avg two files",
		[]service.UploadedFile{
			{Reader: fileA, Filename: "a.bin"},
			{Reader: fileB, Filename: "b.bin"},
		},
		map[string]interface{}{"example_delta_py": map[string]interface{}{}})
	fileA.Close()
	fileB.Close()
	if err != nil {
		t.Fatalf("create benchmark: %v", err)
	}
	if benchmark.FileCount != 2 {
		t.Errorf("file_count = %d, want 2", benchmark.FileCount)
	}

	got := waitForBenchmark(t, ctx, benchRepo, benchmark.ID)
	if got.Status != "ready" {
		t.Fatalf("benchmark status = %q (error: %v), want ready", got.Status, got.Error)
	}

	results, err := resultRepo.FindByBenchmarkID(ctx, benchmark.ID)
	if err != nil || len(results) != 1 {
		t.Fatalf("results = %d (err %v), want 1", len(results), err)
	}
	if results[0].CompressionRatio == nil || *results[0].CompressionRatio != 0.1875 {
		t.Errorf("averaged compression_ratio = %v, want 0.1875", results[0].CompressionRatio)
	}
}
