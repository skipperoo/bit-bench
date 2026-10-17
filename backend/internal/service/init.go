package service

import (
	"bitbench/internal/config"
	"bitbench/internal/repository"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Services struct {
	Auth       *AuthService
	Benchmark  *BenchmarkService
	Compressor *CompressorService
	Preset     *PresetService
}

var App *Services

func InitServices(cfg *config.Config, db *pgxpool.Pool, rdb *redis.Client) {
	userRepo := repository.NewUserRepository(db)
	benchRepo := repository.NewBenchmarkRepository(db)
	resultRepo := repository.NewBenchmarkResultRepository(db)
	pkgRepo := repository.NewCompressorPackageRepository(db)
	taskRepo := repository.NewBenchmarkTaskRepository(db)
	presetRepo := repository.NewPresetRepository(db)
	presetSvc := NewPresetService(presetRepo, pkgRepo, cfg)

	App = &Services{
		Auth:       NewAuthService(userRepo, rdb, cfg),
		Benchmark:  NewBenchmarkService(benchRepo, resultRepo, pkgRepo, taskRepo, presetSvc, cfg),
		Compressor: NewCompressorService(pkgRepo, cfg),
		Preset:     presetSvc,
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
