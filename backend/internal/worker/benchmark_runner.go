package worker

import (
	"context"

	"bitbench/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type BenchmarkRunner struct {
	cfg *config.Config
	db  *pgxpool.Pool
	rdb *redis.Client
}

func NewBenchmarkRunner(cfg *config.Config, db *pgxpool.Pool, rdb *redis.Client) *BenchmarkRunner {
	return &BenchmarkRunner{cfg: cfg, db: db, rdb: rdb}
}

func (r *BenchmarkRunner) Run(ctx context.Context) {
	<-ctx.Done()
}
