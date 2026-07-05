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
		AddHandler("POST  /auth/logout",           handler.Logout).
		AddHandler("PUT   /auth/password",         handler.ChangePassword).
		AddHandler("GET   /me",                    handler.Me).
		AddHandler("GET   /compressors",           handler.ListCompressors).
		AddHandler("GET   /benchmarks/checksums",  handler.ListChecksums).
		AddHandler("POST  /benchmarks",            handler.CreateBenchmark).
		AddHandler("GET   /benchmarks",            handler.ListBenchmarks).
		AddHandler("GET   /benchmarks/{id}",       handler.GetBenchmark).
		AddHandler("GET   /benchmarks/{id}/status", handler.GetBenchmarkStatus).
		AddHandler("GET   /benchmarks/{id}/progress", handler.SSEProgressHandler).
		AddHandler("GET   /benchmarks/compare",    handler.CompareBenchmarks).
		AddHandler("GET   /status",                handler.GetStatus)

	admin := routy.NewRouter()
	admin.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.RequireAdmin).
		AddHandler("POST   /users",                    handler.AdminCreateUser).
		AddHandler("GET    /users",                    handler.AdminListUsers).
		AddHandler("PUT    /users/{id}",               handler.AdminUpdateUser).
		AddHandler("DELETE /users/{id}",               handler.AdminDeleteUser).
		AddHandler("POST   /groups",                  handler.AdminCreateGroup).
		AddHandler("GET    /groups",                  handler.AdminListGroups).
		AddHandler("PUT    /groups/{id}",              handler.AdminUpdateGroup).
		AddHandler("DELETE /groups/{id}",              handler.AdminDeleteGroup).
		AddHandler("GET    /benchmarks",               handler.AdminListBenchmarks).
		AddHandler("DELETE /benchmarks/{id}",          handler.AdminDeleteBenchmark).
		AddHandler("POST   /benchmarks/{id}/cancel",   handler.AdminCancelBenchmark)

	router.AddSubroute("/api/v1/", protected.Finalize())
	router.AddSubroute("/api/v1/admin/", admin.Finalize())
	final := router.Finalize()

	runner := worker.NewBenchmarkRunner(cfg, db, rdb)
	service.App.Benchmark.SetRunningFunc(runner.Running)

	go runner.Run(ctx)
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
