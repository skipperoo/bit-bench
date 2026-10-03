//go:build integration

package worker

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
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

func e2eUserID(t *testing.T) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testDB.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = 'e2e@test.com'`).Scan(&id); err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	return id
}

const e2ePythonCompressor = `import os
import sys

args = sys.argv[1:]
out = None
inp = None
i = 0
while i < len(args):
    a = args[i]
    if a == '-o' and i + 1 < len(args):
        out = args[i + 1]
        i += 2
    elif a == '--options' and i + 1 < len(args):
        i += 2
    elif a.startswith('--'):
        i += 1
    else:
        inp = a
        i += 1

size = os.path.getsize(inp)
header = "compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs\n"
row = "custom_py,ds,%d,%d,,%d,%d,0.5,10.5,20.5,,\n" % (size // 8, size, size * 8, size * 4)
with open(out, "w") as f:
    f.write(header + row)
`

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

func TestBenchmarkRunnerRunsCustomCompressor(t *testing.T) {
	dockerRunner, err := runner.NewDockerRunner(e2eRunnerImage, 2048, 256)
	if err != nil {
		t.Skipf("docker unavailable, skipping E2E: %v", err)
	}
	defer dockerRunner.Close()
	buildImageIfMissing(t, dockerRunner)

	ctx := context.Background()
	dataDir := t.TempDir()
	compressorDir := t.TempDir()

	// Create a ready package directly.
	pkgDir := filepath.Join(compressorDir, "pkg1", "pkg")
	if err := os.MkdirAll(filepath.Join(pkgDir, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "src", "main.py"), []byte(e2ePythonCompressor), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "spec.yaml"), []byte("name: custom_py\nversion: \"1\"\nentrypoint: python3 src/main.py\n"), 0644); err != nil {
		t.Fatal(err)
	}

	specJSON, _ := json.Marshal(map[string]interface{}{
		"name":       "custom_py",
		"version":    "1",
		"entrypoint": "python3 src/main.py",
		"workers":    1,
		"options": map[string]interface{}{
			"level": map[string]interface{}{"type": "number", "min": 1, "max": 9, "default": 6, "step": 1},
		},
	})
	builtPath := "pkg1"
	ownerID := e2eUserID(t)
	pkg := &model.CompressorPackage{
		OwnerID:         ownerID,
		Name:            "custom_py",
		Version:         "1",
		Entrypoint:      "python3 src/main.py",
		Workers:         1,
		Spec:            specJSON,
		Status:          "ready",
		ArchiveChecksum: "00000000000000000000000000000000",
		BuiltPath:       &builtPath,
	}
	pkgRepo := repository.NewCompressorPackageRepository(testDB)
	if err := pkgRepo.Create(ctx, pkg); err != nil {
		t.Fatalf("create package: %v", err)
	}

	// Create the input .bin and the benchmark row.
	filename := "e2e-sample.bin"
	data := make([]byte, 16+8*128)
	for i := 0; i < 128; i++ {
		val := int64(i * 3)
		for b := 0; b < 8; b++ {
			data[16+i*8+b] = byte(val >> (8 * b))
		}
	}
	sum := md5.Sum(data)
	checksum := hex.EncodeToString(sum[:])
	if err := os.WriteFile(filepath.Join(dataDir, service.StoredFilename(filename, checksum)), data, 0644); err != nil {
		t.Fatal(err)
	}

	benchRepo := repository.NewBenchmarkRepository(testDB)
	resultRepo := repository.NewBenchmarkResultRepository(testDB)
	benchmark := &model.Benchmark{
		UserID:           ownerID,
		Name:             "e2e custom run",
		OriginalFilename: filename,
		FileSize:         int64(len(data)),
		FileChecksum:     checksum,
		FileExt:          ".bin",
		Compressors:      map[string]interface{}{"custom_py": map[string]interface{}{"level": float64(9)}},
	}
	if err := benchRepo.Create(ctx, benchmark); err != nil {
		t.Fatalf("create benchmark: %v", err)
	}

	cfg := &config.Config{
		DataDir:          dataDir,
		CompressorDir:    compressorDir,
		BenchBinaryPath:  "/nonexistent/LosslessBenchmarkFull",
		BenchTimeout:     120 * time.Second,
		BenchMaxRetries:  0,
		MaxRunnerWorkers: 4,
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
	if res.Compressor != "custom_py" {
		t.Errorf("compressor = %q", res.Compressor)
	}
	if res.CompressionRatio == nil || *res.CompressionRatio != 0.5 {
		t.Errorf("compression_ratio = %v, want 0.5", res.CompressionRatio)
	}
	if res.MemoryUsage != nil {
		t.Errorf("memory_usage = %v, want NULL (not reported)", *res.MemoryUsage)
	}
	if res.RandomAccessNs != nil || res.RandomAccessMbs != nil {
		t.Error("random access metrics should be NULL when not reported")
	}
}
