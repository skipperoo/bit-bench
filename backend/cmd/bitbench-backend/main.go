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

	recoverMw := routy.NewRecoverMiddleware(nil)
    loggingMw := routy.NewLoggingMiddleware(middleware.LoggingFunc)

	router := routy.NewRouter()
	router.
		AddMiddleware(recoverMw.GetMiddleware()).
		AddMiddleware(loggingMw.GetMiddleware()).
		AddHandler("POST /api/v1/auth/login",   handler.Login).
		AddHandler("GET  /api/v1/health",       handler.HealthCheck).
		AddHandler("GET  /api/v1/config",       handler.GetConfig)

	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddHandler("POST  /v1/auth/logout",           handler.Logout).
		AddHandler("PUT   /v1/auth/password",         handler.ChangePassword).
		AddHandler("GET   /v1/me",                    handler.Me).
		AddHandler("GET   /v1/compressors",           handler.ListCompressors).
		AddHandler("GET   /v1/benchmarks/checksums",  handler.ListChecksums).
		AddHandler("POST  /v1/benchmarks",            handler.CreateBenchmark).
		AddHandler("GET   /v1/benchmarks",            handler.ListBenchmarks).
		AddHandler("GET   /v1/benchmarks/{id}",       handler.GetBenchmark).
		AddHandler("GET   /v1/benchmarks/{id}/status", handler.GetBenchmarkStatus).
		AddHandler("GET   /v1/benchmarks/compare",    handler.CompareBenchmarks).
		AddHandler("GET   /v1/status",                handler.GetStatus)

	admin := routy.NewRouter()
	admin.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.RequireAdmin).
		AddHandler("POST   /v1/admin/users",                handler.AdminCreateUser).
		AddHandler("GET    /v1/admin/users",                handler.AdminListUsers).
		AddHandler("PUT    /v1/admin/users/{id}",           handler.AdminUpdateUser).
		AddHandler("DELETE /v1/admin/users/{id}",           handler.AdminDeleteUser).
		AddHandler("POST   /v1/admin/groups",               handler.AdminCreateGroup).
		AddHandler("GET    /v1/admin/groups",               handler.AdminListGroups).
		AddHandler("PUT    /v1/admin/groups/{id}",          handler.AdminUpdateGroup).
		AddHandler("DELETE /v1/admin/groups/{id}",          handler.AdminDeleteGroup).
		AddHandler("GET    /v1/admin/benchmarks",           handler.AdminListBenchmarks).
		AddHandler("DELETE /v1/admin/benchmarks/{id}",      handler.AdminDeleteBenchmark).
		AddHandler("POST   /v1/admin/benchmarks/{id}/cancel", handler.AdminCancelBenchmark)

	router.AddSubroute("/api/", protected.Finalize())
	router.AddSubroute("/api/", admin.Finalize())
	final := router.Finalize()

	go worker.NewBenchmarkRunner(cfg, db, rdb).Run(ctx)
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
