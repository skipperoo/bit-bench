package config

import (
	"context"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"bitbench/internal/compressor"
)

type Config struct {
	DBHost     string
	DBPort     string
	DBUser     string
	DBPassword string
	DBName     string

	RedisHost     string
	RedisPort     string
	RedisPassword string

	JWTSecret string
	JWTExpiry time.Duration

	MaxParallelism  int
	MaxFileSizeMB   int64
	MaxCompare      int
	BenchTimeout    time.Duration
	BenchMaxRetries int
	DataDir         string
	BenchBinaryPath string

	CompressorDir    string
	MaxPackageSizeMB int64
	RunnerImageAMD64 string
	RunnerImageARM64 string
	HostPlatform     string
	RunnerMemoryMB   int64
	RunnerPidsLimit  int64
	BuildTimeout     time.Duration
	BenchVolume      string
	CompressorVolume string

	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPFrom     string
	SMTPPassword string
}

func LoadConfig() *Config {
	return &Config{
		DBHost:     getEnv("DB_HOST", "localhost"),
		DBPort:     getEnv("DB_PORT", "5432"),
		DBUser:     getEnv("DB_USER", "bitbench"),
		DBPassword: readSecret("db_password"),
		DBName:     getEnv("DB_NAME", "bitbench"),

		RedisHost:     getEnv("REDIS_HOST", "localhost"),
		RedisPort:     getEnv("REDIS_PORT", "6379"),
		RedisPassword: readSecret("redis_password"),

		JWTSecret: readSecret("jwt_secret"),
		JWTExpiry: getDuration("JWT_EXPIRY", 24*time.Hour),

		MaxParallelism:  getInt("MAX_PARALLELISM", runtime.GOMAXPROCS(0)),
		MaxFileSizeMB:   int64(getInt("MAX_FILE_SIZE_MB", 500)),
		MaxCompare:      getInt("MAX_COMPARE_BENCHMARKS", 5),
		BenchTimeout:    getDuration("BENCH_TIMEOUT_SECONDS", 3600*time.Second),
		BenchMaxRetries: getInt("BENCH_MAX_RETRIES", 2),
		DataDir:         getEnv("DATA_DIR", "/data/benchmarks"),
		BenchBinaryPath: getEnv("BENCH_BINARY_PATH", "/app/bin/LosslessBenchmarkFull"),

		CompressorDir:    getEnv("COMPRESSOR_DIR", "/data/compressors"),
		MaxPackageSizeMB: int64(getInt("MAX_PACKAGE_SIZE_MB", 50)),
		RunnerImageAMD64: getEnv("RUNNER_IMAGE_AMD64", "bitbench-runner:amd64"),
		RunnerImageARM64: getEnv("RUNNER_IMAGE_ARM64", "bitbench-runner:arm64"),
		HostPlatform:     compressor.HostPlatform(runtime.GOOS, runtime.GOARCH),
		RunnerMemoryMB:   int64(getInt("RUNNER_MEMORY_MB", 4096)),
		RunnerPidsLimit:  int64(getInt("RUNNER_PIDS_LIMIT", 512)),
		BuildTimeout:     getDuration("BUILD_TIMEOUT_SECONDS", 600*time.Second),
		BenchVolume:      getEnv("BENCH_VOLUME", "bitbench_bench_data"),
		CompressorVolume: getEnv("COMPRESSOR_VOLUME", "bitbench_compressor_data"),

		SMTPHost:     getEnv("SMTP_HOST", ""),
		SMTPPort:     getEnv("SMTP_PORT", "587"),
		SMTPUser:     getEnv("SMTP_USER", ""),
		SMTPFrom:     getEnv("SMTP_FROM", ""),
		SMTPPassword: readSecret("smtp_password"),
	}
}

func (c *Config) SMTPEnabled() bool {
	return c.SMTPHost != ""
}

// RunnerImages maps every supported platform to its runner image tag.
func (c *Config) RunnerImages() map[string]string {
	return map[string]string{
		compressor.PlatformAMD64: c.RunnerImageAMD64,
		compressor.PlatformARM64: c.RunnerImageARM64,
	}
}

// RunnerImageFor returns the configured runner image for a platform.
func (c *Config) RunnerImageFor(platform string) (string, bool) {
	image, ok := c.RunnerImages()[platform]
	return image, ok && image != ""
}

func ConnectDB(ctx context.Context, cfg *Config) (*pgxpool.Pool, error) {
	dsn := "postgres://" + cfg.DBUser + ":" + cfg.DBPassword +
		"@" + cfg.DBHost + ":" + cfg.DBPort + "/" + cfg.DBName +
		"?sslmode=disable"
	return pgxpool.New(ctx, dsn)
}

func ConnectRedis(ctx context.Context, cfg *Config) (*redis.Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisHost + ":" + cfg.RedisPort,
		Password: cfg.RedisPassword,
		DB:       0,
	})
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return rdb, nil
}

func readSecret(name string) string {
	data, err := os.ReadFile("/run/secrets/" + name)
	if err == nil {
		return strings.TrimSpace(string(data))
	}
	return os.Getenv(stringToUpper(name))
}

func stringToUpper(s string) string {
	return s
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

func getDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		if i, err := strconv.Atoi(v); err == nil {
			return time.Duration(i) * time.Second
		}
	}
	return fallback
}
