This is the backlog of BitBench

- [x] means done
- [ ] means that the issue is open

# TODO

## Project bootstrap & tooling

- [ ] Initialize frontend app (Vite + React + TypeScript + Tailwind CSS + Shadcn UI); add Recharts for charting and Zustand only if cross-component state is required
- [ ] Initialize backend app (Go 1.26+, module `bitbench`, `github.com/skipperoo/routy` router); create `internal/{handler,middleware,service,repository,model,worker,config,logger}` packages mirroring the reference layout
- [ ] Initialize admin frontend app (same tech stack, decoupled, separate Vite project + Docker service)
- [ ] Add `backend/scripts/migrate.sh` tracking applied files in a `_migrations` table (idempotent)
- [ ] Add `.github/workflows/ci.yml` with 5 gates: lint (golangci-lint, ESLint + tsc --noEmit), unit (go test, vitest), integration (testcontainers postgres+redis), e2e (Playwright), build (go build, vite build)
- [ ] Add `secrets/` directory + sample secret files; document generation in README

## Database schema & migrations

- [ ] Write `0001_initial.sql` defining all tables: `users`, `groups`, `user_groups`, `benchmarks`, `benchmark_files`, `benchmark_results`, `compressor_options`, `jobs` (or job queue), `_migrations`; define indexes
- [ ] Define role model: `admin` (platform admin) vs `user` (default); fix the contradiction that "other users have role admin"
- [ ] Decide and document job-queue storage (PostgreSQL table vs Redis list) and the job state machine (`queued` -> `in_progress` -> `ready` | `failed` | `timed_out`)
- [ ] Seed default admin user `admin@bitbench.org` / `changeme` on first startup (idempotent)
- [ ] If TimescaleDB is kept, define which table (if any) is a hypertable; otherwise justify the timescaledb image

## Backend — Auth & middleware

- [ ] Implement `POST /api/v1/auth/register` (accept email + password; hash with bcrypt/argon2id; no E2E keypair in BitBench)
- [ ] Implement `POST /api/v1/auth/login` (issue JWT; define claims shape + expiry in spec)
- [ ] Implement `POST /api/v1/auth/logout` (add JWT to Redis blocklist with TTL = remaining lifetime)
- [ ] Implement `PUT /api/v1/auth/password` (update password hash; issue fresh JWT)
- [ ] Implement JWT middleware attaching claims to context; check Redis blocklist on every protected request
- [ ] Define and enforce rate-limiting rules via Redis (login, register, upload)
- [ ] Implement admin-only authorization middleware (role check) for admin endpoints

## Backend — Benchmark & compression endpoints

- [ ] Implement `GET /api/v1/compressors` returning the compressor-options dictionary (name -> option -> {type, min, max, default, required}) consumed by the frontend advanced-options accordion
- [ ] Implement compressor-option extraction from the benchmark binary help message; document the parse grammar and the option schema (types: number/boolean/select; ranges; >20 items -> num input, <=20 -> slider)
- [ ] Implement `GET /api/v1/benchmarks/checksums` (or similar) returning MD5 checksums of already-processed files for client-side duplicate detection
- [ ] Implement `POST /api/v1/benchmarks` to accept the upload (multipart), benchmark name, selected compressors + options; perform server-side file-size + type + checksum validation; rename to `OG-FILENAME-ESCAPED-FILEHASH.EXT`
- [ ] Implement `GET /api/v1/benchmarks` (list, searchable by name, paginated) returning card data: name, file size, status, datetimes, compressor pills
- [ ] Implement `GET /api/v1/benchmarks/{id}` returning full results for the detail page charts (all metrics per compressor, including range-query columns)
- [ ] Implement `GET /api/v1/benchmarks/{id}/status` (or fold into above) for polling queued/in-progress state
- [ ] Implement `GET /api/v1/benchmarks/compare?ids=...` (up to 5) returning merged data for the compare page
- [ ] Implement `GET /api/v1/status` returning work-queue depth, runner status, and submitted-job statistics
- [ ] Define the benchmark result CSV schema the backend parses: `compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs,<range_query_N>...`
- [ ] Implement admin CRUD endpoints: users (list/update role/delete), groups (create/list/assign priority), benchmarks (list/cancel/delete)

## Backend — Benchmark runner worker

- [ ] Implement the Benchmark Runner worker: pull pending jobs, run the benchmark binary as a subprocess, cap concurrency at `MAX_PARALLELISM`
- [ ] Document subprocess invocation: binary path, `-c <compressors>` and `-o <out>` flags, timeout (`BENCH_TIMEOUT_SECONDS`), LD_LIBRARY_PATH for bundled Squash libs
- [ ] Implement result `.txt` (CSV) parsing into `benchmark_results` rows; handle multi-signal averaging
- [ ] Implement job status transitions + failure/retry policy (max retries, timeout -> `timed_out`)
- [ ] Build the `compression/` C++ artifacts with the backend (CMake); document when the build happens (image build vs startup vs on-demand)
- [ ] Optional SMTP: email dispatcher worker active only when SMTP credentials are configured; otherwise skipped (no password reset via mail)

## Frontend — Auth & layout

- [ ] Login page (email + password; error states; loading state)
- [ ] Register page (email + password; validation; error states)
- [ ] Responsive app shell (desktop-first, must not break on mobile); router with protected routes
- [ ] Reuse/adapt general-purpose React components and backend utilities from `reference/budgeteer` per the styling guide

## Frontend — Main / upload page

- [ ] Brief platform introduction + accepted file-type/structure instructions
- [ ] Benchmark name input
- [ ] Upload / drag-and-drop area with client-side validation (type + size from env-configured `MAX_FILE_SIZE`)
- [ ] Run button (disabled until valid)
- [ ] "Advanced Options" accordion: for each compressor, render option fields (slider for <=20-item ranges, number input for >20) driven by `GET /api/v1/compressors`
- [ ] Duplicate check: fetch checksums and block upload of already-processed files (MD5)
- [ ] Define the env var name for the max file size and expose it to the frontend

## Frontend — Results page

- [ ] Top-center search bar (search benchmark by name)
- [ ] Square benchmark cards: name, file size, status pill (queued=blue, ready=green, in-progress=yellow) with pulsing dot, upload/started/finished datetimes
- [ ] Compressor pills (tag style, bottom-center; show up to 4-5, then `+N other` with hover details)

## Frontend — Benchmark detail page

- [ ] Top-5 summary (define the ranking key: best compression_ratio by default; bold/underline/italic for top-3)
- [ ] Reproduce the `final_results.html` charts from `scripts/generate_full_html_report.py` using Recharts:
  - [ ] Overview grouped bar chart: compression_ratio (%) by compressor per dataset
  - [ ] Per-metric accordion sections, each with a chart + a ranked table, for: compression_ratio, compression_throughput_mbs, decompression_throughput_mbs, memory_usage, compressor_internal, relative_memory_usage, internal_memory_ratio, random_access_ns, random_access_mbs, range-query throughputs
  - [ ] Scatter (Pareto) plots: each throughput/latency metric vs compression_ratio (%), colored/shaped by compressor family
- [ ] Ranking rules: lower-is-better for compression*ratio, memory**, random_access_ns,*\_bits, *\_ns; higher-is-better for throughputs (*\_mbs). Best=bold, 2nd=underline, 3rd=italic
- [ ] Single-signal assumption: no multi-signal per benchmark (per AGENTS.md), so omit per-signal drill-down

## Frontend — Compare page

- [ ] Select up to 5 benchmarks
- [ ] Render the same plot set as the detail page, overlaid/merged across the selected benchmarks

## Frontend — Status page

- [ ] Work-queue status, benchmark runner status, submitted-job statistics

## Admin frontend

- [ ] Decoupled CRUD app: users (role assignment), groups (priority), benchmarks (view/cancel/delete in-progress)
- [ ] Separate Docker Compose service

## Deployment

- [ ] `docker-compose.yml` with services: frontend, backend, postgres (timescale), redis, admin-frontend (currently missing the admin service)
- [ ] Strict secret management: jwt_secret, db_password, smtp_password, redis_password (no secrets in env vars)
- [ ] Backend env: DB_HOST, DB_USER, DB_NAME, REDIS_HOST, MAX_PARALLELISM, MAX_FILE_SIZE, BENCH_TIMEOUT_SECONDS, RULES_CHECK_INTERVAL (if kept), SMTP config (optional)
- [ ] Healthchecks + graceful shutdown + dependency ordering

## Tests (per CI gate; replace Budgeteer-specific items)

- [ ] Backend unit: CSV result parser, checksum computation, option-extraction parser, job-state predicates
- [ ] Backend integration (testcontainers pg+redis): each handler happy + error path; auth register->login->logout + JWT blocklist eviction; upload + duplicate-rejection; runner subprocess end-to-end
- [ ] Frontend unit (Vitest): file-validation logic, checksum/duplicate logic, option-form rendering rules
- [ ] Frontend component (React Testing Library): upload form states, status pills, error/loading states
- [ ] E2E (Playwright): register, login, upload a benchmark, view detail charts, compare 2 benchmarks — NOT Budgeteer journeys (no transactions/joint accounts)

# BUGS
