# BitBench — Backlog

- [x] done
- [ ] open

## Branch Map (all done ✓)

| # | Branch | Status | What |
|:-:|:--|:--:|:--|
| 1 | `feature/project-bootstrap` | ✓ | Go module, Vite frontends, DB schema, Docker scaffold, CI scaffold |
| 2 | _(merged into 1)_ | ✓ | Database schema + migrations + seed |
| 3 | _(merged into 1)_ | ✓ | Config loader, logger, DB/Redis connections, health endpoint |
| 4 | `feature/auth` | ✓ | JWT auth (bcrypt + HS256), Redis blocklist, rate limiting, login page |
| 5 | `feature/compressor-registry` | ✓ | C++-derived compressor options, slider/number rule, unit tests |
| 6 | `feature/benchmark-crud` | ✓ | Upload/list/detail/compare/status + Recharts pages |
| 7 | `feature/benchmark-runner` | ✓ | Worker pool, CSV parser, file normalizer, subprocess executor |
| 8 | `feature/admin` | ✓ | Admin CRUD (users, groups, benchmarks) + admin frontend |
| 9 | `feature/auth-docker-finalize` | ✓ | Login SMTP link, loading spinner, Angie proxy, Dockerfiles, setup.sh |
| 10 | `feature/ci-pipeline` | ✓ | Unit tests (Go: 20, Frontend: 19), integration tests (testcontainers), CI |

## Detailed progress

### Backend
- [x] Go module (`bitbench`), router (routy), 9 internal packages
- [x] Config: env vars + Docker secrets, DB/Redis connections, migrations, seed
- [x] Logger: structured JSON logging (slog)
- [x] Auth: JWT (HS256), bcrypt, Redis blocklist, rate limiting
- [x] Middleware: JWTAuth + RequireAdmin + CORS + logging + rate limiter
- [x] Handlers: all 30+ endpoints (public, protected, admin)
- [x] Services: AuthService (login/logout/password/me), BenchmarkService (CRUD)
- [x] Repositories: User, Group, Benchmark, BenchmarkResult
- [x] Compressor registry: 28 compressors with C++-derived options
- [x] Workers: BenchmarkRunner (pool, CSV parse, normalize, subprocess), EmailDispatcher
- [x] Unit tests: 20 tests for compressor, model, middleware, service, worker
- [x] Integration tests: 7 auth tests with testcontainers (Postgres + Redis)

### Frontend (main)
- [x] Vite + React 19 + TypeScript + Tailwind CSS 4 + Shadcn UI
- [x] Components: Button, Card, Input, Label, Badge, Switch, Select, Slider
- [x] Auth: login page (SMTP-aware forgot-password), Zustand store, API client
- [x] Upload: drag-drop, compressor options (slider vs number), MD5 duplicate check
- [x] Results: cursor-based pagination, status pills with pulse animation
- [x] Detail: Pareto top-5, bar charts, scatter plots, ranked tables (Recharts)
- [x] Compare: multi-benchmark selection, overlaid charts
- [x] Status: queue depth, runner stats, job counts
- [x] Tests: 19 Vitest tests (options, MD5, Pareto)

### Admin Frontend
- [x] Separate Vite project, dark sidebar layout
- [x] Login with admin role verification
- [x] Users: create, list, reset password, delete
- [x] Groups: create, list, inline priority edit, delete
- [x] Benchmarks: list all, cancel, delete

### Docker / Deployment
- [x] Multi-stage Dockerfiles: backend (C++ + Go), frontend (nginx), admin-frontend (nginx)
- [x] Docker Compose: Angie reverse proxy, frontend, admin-frontend, backend, postgres, redis
- [x] Secrets management: auto-generated via `scripts/setup.sh`, Docker secrets
- [x] Nginx configs: SPA fallback, cache headers, API proxy

### CI Pipeline
- [x] GitHub Actions: lint (go vet, tsc), unit tests (go test, vitest), integration (testcontainers), build
- [x] Branch protection: no pushes to master

## Remaining (future)
- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)
