package service

import (
	"bitbench/internal/config"
	"bitbench/internal/repository"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Services struct {
	Auth      *AuthService
	Benchmark *BenchmarkService
}

var App *Services

func InitServices(cfg *config.Config, db *pgxpool.Pool, rdb *redis.Client) {
	userRepo := repository.NewUserRepository(db)
	benchRepo := repository.NewBenchmarkRepository(db)
	resultRepo := repository.NewBenchmarkResultRepository(db)

	App = &Services{
		Auth:      NewAuthService(userRepo, rdb, cfg),
		Benchmark: NewBenchmarkService(benchRepo, resultRepo, cfg),
	}
}

// Repos exposes repositories for handler-level use (admin CRUD).
var UserRepo *repository.UserRepository
var GroupRepo *repository.GroupRepository
var BenchRepo *repository.BenchmarkRepository

func InitRepos(db *pgxpool.Pool) {
	UserRepo = repository.NewUserRepository(db)
	GroupRepo = repository.NewGroupRepository(db)
	BenchRepo = repository.NewBenchmarkRepository(db)
}
