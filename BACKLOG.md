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

## Branch 7: feature/benchmark-runner ✓

- [x] CSV result parser: header detection with dynamic range_query_<N> columns, all required columns, error handling
- [x] File normalization: .bin copy, CSV→per-column .bin conversion (16-byte header), zip/tar extraction
- [x] .bin format detection (16-byte preferred over 8-byte, matching C++ behavior)
- [x] Subprocess invocation with `timeout`, LD_LIBRARY_PATH, stderr capture
- [x] Compressor name mapping: pfordelta codec option → `pfordelta_<codec>` name suffix
- [x] Result averaging across multiple .bin files (per compressor)
- [x] Runner pool: claim via `FOR UPDATE SKIP LOCKED` with priority ordering (COALESCE NULL group → 0)
- [x] Job state machine: claim→in_progress, timeout→timed_out, non-zero→retry→failed, success→ready
- [x] File cleanup after completion/deletion
- [x] Retry policy (BENCH_MAX_RETRIES)
- [x] Unit tests: CSV parser (with range queries, missing columns), AverageRows, BuildCompressorList (including pfordelta mapping), .bin header detection (16-byte, 8-byte, invalid, 8-byte-prefers-16), Read/WriteBinFile, NormalizeFile

## Branch 8: feature/admin ✓

- [x] UserRepository: Create, List, Update (role/group_id/password), SoftDelete
- [x] GroupRepository: Create, FindByID, List, Update (name/priority), Delete
- [x] InitRepos for handler-level access to repositories
- [x] Admin handlers: users CRUD, groups CRUD, benchmarks list/cancel/delete
- [x] Admin frontend: login page (admin role check), sidebar layout, Users CRUD (create/reset-password/delete), Groups CRUD (create/priority/delete), Benchmarks list/cancel/delete

## Branch 10: feature/ci-pipeline ✓

- [x] Go unit tests: JWT token generation/validation (6 tests), rate limiter (4 tests), filename escaping/stored filename/extension validation, benchmark service utilities
- [x] Go integration tests (testcontainers): auth handler tests with real Postgres + Redis — login success, invalid credentials, nonexistent user, logout blocklist, /me endpoint, unauthenticated access
- [x] Frontend vitest setup: added vitest, @testing-library/react, jsdom; test script; vite.config.ts test config
- [x] Frontend unit tests: MD5 computation (4 tests + shape check), Pareto domination count (6 tests)
- [x] Frontend options tests (from branch 5, 7 tests)
- [x] CI workflow updated: proper `go vet` for lint, separate unit/integration/build jobs, npm ci for frontend deps

### Remaining (out of scope for this pass):
- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)  
- [ ] Test docker-compose up end-to-end
