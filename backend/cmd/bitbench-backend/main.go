package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/skipperoo/routy"
	"bitbench/internal/config"
	"bitbench/internal/handler"
	"bitbench/internal/logger"
	"bitbench/internal/middleware"
	"bitbench/internal/runner"
	"bitbench/internal/service"
	"bitbench/internal/worker"
)

func main() {
	logger.InitLogger()
	defer logger.CloseLogger()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := config.LoadConfig()

	db, err := config.ConnectDB(ctx, cfg)
	if err != nil {
		logger.Fatal("failed to connect to database", "error", err)
	}
	defer db.Close()

	rdb, err := config.ConnectRedis(ctx, cfg)
	if err != nil {
		logger.Fatal("failed to connect to redis", "error", err)
	}
	defer rdb.Close()

	if err := config.RunMigrations(ctx, db); err != nil {
		logger.Fatal("failed to run migrations", "error", err)
	}
	if err := config.Seed(ctx, db); err != nil {
		logger.Fatal("failed to seed database", "error", err)
	}

	service.InitServices(cfg, db, rdb)
	service.InitRepos(db)
	handler.InitHandlers(cfg)
	middleware.InitAuthMiddleware(rdb)
	middleware.InitUserResolver(service.UserRepo)

	dockerRunner, dockerErr := runner.NewDockerRunner(cfg.RunnerImage, cfg.RunnerMemoryMB, cfg.RunnerPidsLimit)
	if dockerErr != nil {
		logger.Warn("docker runner unavailable; compressor packages will not build or run", "error", dockerErr)
	} else {
		defer dockerRunner.Close()
		service.App.Compressor.SetRunner(dockerRunner)
		if err := dockerRunner.Ping(ctx); err != nil {
			logger.Warn("compressor runner not ready", "error", err)
		}
	}

	recoverMw := routy.NewRecoverMiddleware(nil)
	loggingMw := routy.NewLoggingMiddleware(middleware.LoggingFunc)

	rl := middleware.NewRateLimiter(rdb, 5, time.Minute, middleware.IPKeyFunc)
	loginHandler := rl.Wrap(handler.Login)

	router := routy.NewRouter()
	router.
		AddMiddleware(recoverMw.GetMiddleware()).
		AddMiddleware(loggingMw.GetMiddleware()).
		AddHandler("POST /api/v1/auth/login",   loginHandler).
		AddHandler("GET  /api/v1/health",       handler.HealthCheck).
		AddHandler("GET  /api/v1/config",       handler.GetConfig)

	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST  /auth/logout",           handler.Logout).
		AddHandler("PUT   /auth/password",         handler.ChangePassword).
		AddHandler("PUT   /me/config",             handler.SaveLastConfig).
		AddHandler("GET   /me",                    handler.Me).
		AddHandler("GET   /compressors",           handler.ListCompressors).
		AddHandler("POST  /compressors/packages",  middleware.RequireUploader(handler.UploadCompressorPackage)).
		AddHandler("GET   /compressors/packages",  handler.ListCompressorPackages).
		AddHandler("GET   /compressors/packages/{id}", handler.GetCompressorPackage).
		AddHandler("DELETE /compressors/packages/{id}", handler.DeleteCompressorPackage).
		AddHandler("GET   /benchmarks/checksums",  handler.ListChecksums).
		AddHandler("POST  /benchmarks",            handler.CreateBenchmark).
		AddHandler("GET   /benchmarks",            handler.ListBenchmarks).
		AddHandler("GET   /benchmarks/{id}",       handler.GetBenchmark).
		AddHandler("GET   /benchmarks/{id}/status", handler.GetBenchmarkStatus).
		AddHandler("GET   /benchmarks/{id}/progress", handler.ProgressHandler).
		AddHandler("GET   /benchmarks/compare",    handler.CompareBenchmarks).
		AddHandler("GET   /status",                handler.GetStatus)

	admin := routy.NewRouter()
	admin.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST   /users",                    middleware.RequireAdminOrProfessor(handler.AdminCreateUser)).
		AddHandler("GET    /users",                    middleware.RequireAdminOrProfessor(handler.AdminListUsers)).
		AddHandler("PUT    /users/{id}",               middleware.RequireAdminOrProfessor(handler.AdminUpdateUser)).
		AddHandler("DELETE /users/{id}",               middleware.RequireAdminOrProfessor(handler.AdminDeleteUser)).
		AddHandler("POST   /groups",                  middleware.RequireAdmin(handler.AdminCreateGroup)).
		AddHandler("GET    /groups",                  middleware.RequireAdminOrProfessor(handler.AdminListGroups)).
		AddHandler("PUT    /groups/{id}",              middleware.RequireAdmin(handler.AdminUpdateGroup)).
		AddHandler("DELETE /groups/{id}",              middleware.RequireAdmin(handler.AdminDeleteGroup)).
		AddHandler("GET    /benchmarks",               middleware.RequireAdmin(handler.AdminListBenchmarks)).
		AddHandler("DELETE /benchmarks/{id}",          middleware.RequireAdmin(handler.AdminDeleteBenchmark)).
		AddHandler("POST   /benchmarks/batch-delete",  middleware.RequireAdmin(handler.AdminBatchDeleteBenchmarks)).
		AddHandler("POST   /benchmarks/{id}/cancel",   middleware.RequireAdmin(handler.AdminCancelBenchmark))

	router.AddSubroute("/api/v1/", protected.Finalize())
	router.AddSubroute("/api/v1/admin/", admin.Finalize())
	final := router.Finalize()

	benchRunner := worker.NewBenchmarkRunner(cfg, db, rdb)
	service.App.Benchmark.SetRunningFunc(benchRunner.Running)
	if dockerRunner != nil {
		benchRunner.SetContainerRunner(dockerRunner)
	}

	go benchRunner.Run(ctx)
	go worker.NewEmailDispatcher(cfg, db).Run(ctx)

	server := &http.Server{
		Addr:              ":8080",
		Handler:           final,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("server starting", "addr", ":8080")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server error", "error", err)
		}
	}()

	<-quit
	logger.Info("shutting down server...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	server.Shutdown(shutdownCtx)
	cancel()
}
