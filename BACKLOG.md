# BitBench — Backlog

- [x] means done
- [ ] means that the issue is open

# Done

## Branch 1: feature/project-bootstrap ✓

- [x] Initialize backend Go module (`bitbench`) with directory structure: `internal/{config,logger,middleware,handler,service,repository,model,worker,compressor}`, `cmd/bitbench-backend/main.go`
- [x] Add Go dependencies: routy, pgx/v5, go-redis/v9, golang-jwt/v5, uuid, bcrypt
- [x] Initialize frontend (Vite + React + TypeScript + Tailwind CSS 4)
- [x] Install frontend deps: react-router-dom, zustand, recharts, lucide-react, shadcn/ui primitives, tailwindcss-animate, class-variance-authority, clsx, tailwind-merge
- [x] Initialize admin-frontend (separate Vite project)
- [x] Create backend package skeletons: config (env/secrets loader, DB/Redis connections, migrations, seed), logger (slog), middleware (JWTAuth, RequireAdmin, CORS, logging), handler stubs for all endpoints, model (all types + JWT token), worker stubs (BenchmarkRunner, EmailDispatcher), compressor registry with inferred C++ parameters
- [x] Create database migration: `0001_initial.sql` (groups, users, benchmarks, benchmark_results, email_outbox, _migrations)
- [x] Create `migrate.sh` script + Go embed-based migration runner
- [x] Seed default admin user + default group on startup
- [x] Create Docker Compose + multi-stage Dockerfiles (backend, frontend, admin-frontend, postgres, redis)
- [x] Create secrets directory with placeholder files
- [x] Create `.github/workflows/ci.yml` (lint, unit, integration, build gates)
- [x] Create `.gitignore`
- [x] Frontend: UI components (Button, Card, Input, Label, Badge, Switch, Select), AppLayout with nav, LoginPage, UploadPage, ResultsPage, DetailPage, ComparePage, StatusPage, API client (apiFetch), Zustand auth store, routing with ProtectedRoute

# TODO

## Branch 2: feature/database-schema — Migration 0001_initial.sql, migrate.sh script, seed logic (default admin + default group)

Already completed in bootstrap branch. Future migrations will go here.

## Branch 3: feature/backend-foundations — Config loader, logger, database/redis connections, health endpoint, base middleware (CORS, recover, structured logger)

Already completed in bootstrap branch. Testing and refinements to be added.

## Branch 4: feature/auth — Backend: login, logout, password change, JWT middleware, RequireAdmin, rate limiting. Frontend: login page, app shell, routing, auth state (Zustand), protected routes

- [ ] Implement actual credential validation in Login handler (query DB, bcrypt compare)
- [ ] Implement JWT generation in Login (move from placeholder to real)
- [ ] Implement Logout: add JWT to Redis blocklist with TTL = remaining lifetime
- [ ] Implement ChangePassword: update password hash, issue fresh JWT
- [ ] Implement Me: return full user profile from DB (not just claims)
- [ ] Implement Redis blocklist check in JWTAuth middleware
- [ ] Implement Redis rate limiting for login (5/min/IP)
- [ ] Frontend: login error states, forgot-password link (conditional on SMTP), logout API call
- [ ] Integration tests: login → logout + JWT blocklist eviction

## Branch 5: feature/compressor-registry ✓

- [x] Verify registry matches C++ sources exactly (gzip level fixed by name, pfordelta codec select, Squash-based compressors added)
- [x] Registry updated: gzip_1/6/9 → empty options (level encoded in name); added bzip2, lz4, zstd, brotli, xz, snappy (Squash-only, empty)
- [x] Add unit tests for registry serialization and all compressors
- [x] Frontend: Slider component created
- [x] Frontend: render slider vs number input based on step count rule (≤20 steps = slider, >20 = number)
- [x] Frontend: options utility (shouldUseSlider / stepsForOption) with tests

## Branch 6: feature/benchmark-crud ✓

- [x] BenchmarkRepository: Create, FindByID, FindByChecksum, List (cursor-based), UpdateStatus, ListChecksums, GetStatusStats, Delete
- [x] BenchmarkResultRepository: Insert (upsert), FindByBenchmarkID, FindByBenchmarkIDs (for compare)
- [x] BenchmarkService: CreateBenchmark (file validation, MD5 dedup, size check, file storage), List (cursor-based with search/status filter), GetBenchmark (with results), GetBenchmarkStatus, CompareBenchmarks (up to 5), ListChecksums, GetStatus (queue depth + stats)
- [x] File utilities: MD5 checksum, filename escaping per spec, file extension validation
- [x] Handlers: CreateBenchmark (multipart), ListBenchmarks (cursor pagination), GetBenchmark, GetBenchmarkStatus, CompareBenchmarks, ListChecksums, GetStatus
- [x] Frontend: UploadPage with client-side MD5 duplicate check (spark-md5)
- [x] Frontend: ResultsPage with cursor-based infinite scroll ("Load More"), status pills with pulsing dots
- [x] Frontend: DetailPage with Top-5 Pareto table, overview bar chart, per-metric accordion sections (bar/scatter charts), Pareto scatter plots — all via Recharts
- [x] Frontend: ComparePage with 2-5 benchmark selection, overlaid bar + scatter charts
- [x] Frontend: StatusPage with worker/queue stats

## Branch 7: feature/benchmark-runner — Background worker, CSV parser, file normalization, subprocess execution, result averaging

- [ ] Implement CSV result parser (header with dynamic range_query_<N> columns)
- [ ] Implement file normalization: CSV → per-column .bin, zip/tar extraction
- [ ] Implement .bin format detection (8-byte vs 16-byte header)
- [ ] Implement subprocess invocation with timeout
- [ ] Implement result averaging across multiple .bin files
- [ ] Implement job state machine transitions
- [ ] Implement retry policy
- [ ] Implement file cleanup after completion
- [ ] Implement filename escaping per spec
- [ ] Unit tests: CSV parser, bin header detection, filename escaping
- [ ] Integration test: enqueue → run → parse → ready → files deleted

## Branch 8: feature/admin — Admin CRUD endpoints + admin frontend app

- [ ] Admin CRUD handlers with actual DB operations
- [ ] Admin frontend: user management, group management, benchmark management
- [ ] Integration tests for admin endpoints

## Branch 9: feature/deployment — Docker Compose, multi-stage Dockerfiles, secrets

Already scaffolded in branch 1. To complete:
- [ ] Test docker-compose up with all services
- [ ] Verify secret mounting
- [ ] Add healthcheck + graceful shutdown verification

## Branch 10: feature/ci-pipeline — CI workflow with 5 gates, tests

Already scaffolded in branch 1. To complete:
- [ ] Write Go unit tests (CSV parser, MD5, filename escaping, bin header detection, Pareto score, compressor registry)
- [ ] Write Go integration tests with testcontainers
- [ ] Write frontend unit tests (Vitest)
- [ ] Write frontend component tests (React Testing Library)
- [ ] Write E2E tests (Playwright)
- [ ] Enable and verify CI pipeline
