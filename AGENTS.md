# BitBench — Technical Specifications

> **Revision 4** — Supersedes Revision 3. Replaces the benchmark-per-goroutine runner with a **task-based scheduler over a single CPU worker budget** (`MAX_PARALLELISM` = allocatable cores): one benchmark can fan its `.bin` files and custom packages across the whole pool with priority + fair-share claiming, multi-file uploads are averaged into one benchmark, normalization happens at upload, and crash recovery re-queues interrupted tasks. All design decisions are recorded inline (marked **[DECISION]**).
>
> **Revision 3** — Supersedes Revision 2. Adds the role hierarchy (`admin`/`professor`/`phd`/`student`) with DB-resolved permissions, the CPU section on the status endpoint/page, and **user-provided compressor packages**: package format (`spec.yaml`), package API, offline builds, sandboxed runner containers, worker-slot scheduling, group-scoped visibility, management UI, examples and documentation. All design decisions are recorded inline (marked **[DECISION]**).
>
> **Revision 2** — Supersedes Revision 1. Incorporates implementation decisions discovered during the build: subroute prefix conflict resolution (routy), postgres 18 volume layout, secret trimming, nginx resolver for dynamic upstream resolution, TS 6 `paths` without `baseUrl`. All design decisions are recorded inline (marked **[DECISION]**).
>
> **Revision 1** — Initial full specification produced by the audit/enrichment pass. This revision supersedes the original sketch and fixes every entry in `BACKLOG.md # BUGS`: the `/v1/bechmarks` route typo, the `admin`-role contradiction, all copy-pasted Budgeteer testing/worker content, the incomplete `.bin` format, the missing admin Docker service, the undefined max-file-size env var, the ambiguous filename-escaping rule, the missing compressor-options/checksum/results/compare/status endpoints, the missing database schema, the underspecified compressor-options source, and the too-vague detail-page chart reference. All design decisions are recorded inline (marked **[DECISION]**).

---

## 1. System Overview

BitBench is a compression-algorithm testing platform. A user (created by an admin or a professor) uploads a file containing one or more integer sequences, selects compressors (built-in and/or user-provided packages) and their options, and the platform runs the benchmark binary as a subprocess (built-ins) or in a sandboxed container (user packages). The backend parses the CSV results, stores one **averaged row per compressor**, and the frontend renders ranked tables, bar charts, and Pareto scatter plots to rank the best compressors for that data.

**Target platforms:** Web (desktop-first, responsive down to mobile). No native apps.

**Out of scope:** open self-registration, end-to-end encryption, offline-first sync, time-series hypertables, OTP/email verification. BitBench is a server-authoritative, online-only tool.

### Design decisions (locked)

| # | Decision | Rationale |
|:-:|:--|:--|
| D1 | **Staff-created accounts only.** No `POST /auth/register`. Admin creates users from the admin panel; professors create `phd`/`student` users in their own group. | Matches "SMTP optional; no password reset via mail." |
| D2 | **Auth = email + password + JWT.** No OTP, no E2E keypairs, no X25519. | BitBench has no sensitive per-user payload to encrypt. |
| D3 | **Job queue = PostgreSQL `benchmarks` table + `FOR UPDATE SKIP LOCKED`.** No separate `jobs` table; a row with `status='queued'` is the queue. | Durable, transactional with results, restart-safe, no extra moving parts. |
| D4 | **Backend normalizes all uploads to `.bin` before invoking the subprocess.** CSV → one `.bin` per column; zip/tar → extracted `.bin` files. | The benchmark binary only accepts `.bin`. |
| D5 | **Files are stored locally and DELETED when the benchmark finishes** (after results are parsed and persisted). | Ephemeral; re-running requires re-upload. |
| D6 | **One upload = one benchmark = one averaged result row per compressor.** The MD5 checksum is used for the stored filename and is indexed, but re-uploading the same file is allowed (migration `0004` dropped the global uniqueness constraint so a dataset can be re-run with different compressors). | Matches the report's averaging model while keeping re-runs practical. |
| D7 | **Plain PostgreSQL** (`postgres:18-alpine`), not TimescaleDB. | No time-series data in BitBench. |
| D8 | **Compressor options = static Go registry** in `internal/compressor/registry.go`. The agent MUST first explore `compression/benchmark/*.cpp` and the compressor headers to infer each compressor's tunable parameters from its function/constructor parameters, then encode them. | The `-h` output only lists compressor names, not options. |
| D9 | **C++ artifacts built at backend image build time** via a multi-stage Dockerfile (CMake + make). | Reproducible, fast startup, no toolchain in the runtime image. |
| D10 | **Groups drive scheduling via an integer `priority`; strict higher-priority-first, FIFO within the same priority.** | Simple, predictable. |
| D11 | **Detail page = full parity with `final_results.html`**: overview bar + per-metric accordions (chart + ranked table) + Pareto scatter. | Faithful to the reference report. |
| D12 | **Top-5 summary = composite Pareto score** over (minimize `compression_ratio`, maximize `compression_throughput_mbs`). Formula in §3.5. | Balances size and speed. |
| D13 | **Reverse proxy = nginx** (`nginx:alpine`), config at `nginx/nginx.conf`. Single entry point routing `/api/*` → backend, `/*` → frontend, port 81 → admin-frontend. | Standard nginx, well-known, simple configuration. |
| D14 | **Redis image = `redis:latest`** (not 7-alpine). | Simpler maintenance; pinning to `latest` is acceptable for this project's deployment scope. |
| D15 | **routy subroute prefix conflict resolution.** Protected routes mounted under `/api/v1/` (handler paths without `/v1/` prefix); admin routes mounted under `/api/v1/admin/` (handler paths without `/v1/admin/` prefix). Go's `ServeMux` panics if two subrouters share the same prefix. | Avoids `panic: pattern conflicts` at router finalization. |
| D16 | **Postgres 18 volume layout.** `pg_data` volume mounted at `/var/lib/postgresql` (not `/var/lib/postgresql/data`). Postgres 18+ uses major-version-specific subdirectory layout compatible with `pg_upgrade --link`. | Required by postgres:18-alpine entrypoint; old mount point causes startup failure. |
| D17 | **Secret trimming.** `readSecret()` in `config.go` trims whitespace via `strings.TrimSpace` before returning the value. Secret files created by `echo` include a trailing newline. | Avoids `invalid control character in URL` when building the Postgres DSN. |
| D18 | **Nginx dynamic upstream resolution.** The reverse proxy uses `resolver 127.0.0.11` (Docker's embedded DNS) with `set $upstream "backend:8080"; proxy_pass http://$upstream;` instead of static `proxy_pass http://backend:8080`. | Nginx resolves hostnames at startup; if the backend container isn't ready yet, nginx crashes. Dynamic resolution retries at request time. |
| D19 | **Role hierarchy `admin` > `professor` > `phd` > `student`.** Permissions are resolved **from the database on every request** (`middleware.ResolveUser`), not from JWT claims, so role/group changes and deletions take effect immediately. Existing `user` accounts migrate to `student` (migration `0005`). Only `admin` manages groups/priorities and creates admins/professors; `professor` manages `phd`/`student` users of their own group; `phd` can upload compressor packages; `student` can only run benchmarks. | Avoids stale privileges for the 24h token lifetime. |
| D20 | **User-provided compressors are `.zip` packages** with `spec.yaml` at the root (`name`, `version`, `entrypoint`, `workers`, `options`, optional `build`). Uploaded by `admin`/`professor`/`phd`; **built once, offline**, at upload time in the runner image. Re-uploading the same name by the same owner replaces the package; names are globally unique and cannot collide with built-ins. | Reproducible, no toolchain in the backend runtime image, offline sandbox. |
| D21 | **Runner containers are spawned by the backend via the Docker socket** (`internal/runner`, Docker SDK). The runner containers never receive the socket. Files are exchanged through the named volumes `bitbench_bench_data` (rw) and `bitbench_compressor_data` (ro for runs, rw for builds) mounted at the same absolute paths in both containers. | Simple, restart-safe, no extra service; untrusted code is confined to the runner container. |
| D22 | **Unified CPU worker budget.** `MAX_PARALLELISM` is the total budget and defaults to the cores allocatable to the process (`runtime.GOMAXPROCS(0)`, cgroup-aware), overridable by env. Work is split into claimable `benchmark_tasks`: a built-in `.bin` task costs 1 unit and a custom `(bin × package)` task costs the package's declared `workers`. The scheduler never lets the sum of running task costs exceed the budget and never spawns more task goroutines than the budget. Containers get `--cpus=workers`; cgroup throttling beyond `max(2s, 5% of runtime)` kills the run and fails the benchmark. `MAX_RUNNER_WORKERS` is removed; `spec.yaml:workers` is validated against the budget at upload and run time. | Prevents CPU oversubscription and enforces declared parallelism with one accounting model. |
| D26 | **One benchmark per averaging upload, fanned out as tasks.** Multiple selected files are normalized to `.bin` **at upload** (`POST /benchmarks` accepts repeated `files`), stored under `DATA_DIR/<benchmark_id>/inputs/`, and fanned out as one built-in task per `.bin` plus one task per `(custom package × .bin)`. When all tasks complete, the scheduler averages their rows into one row per compressor. The source uploads are deleted right after normalization. | Parallelizes averaging without changing the "one averaged row per compressor" result model. |
| D27 | **Scheduling policy: strict priority, fair share, no preemption.** Claim order is group `priority` DESC, then the benchmark with the fewest **running worker units** (fair share), then FIFO. The scheduler claims the best-fitting task that fits in the free budget, so a large custom task waits while smaller tasks keep the pool busy. Higher-priority work never interrupts running tasks; it takes the next freed units. Retries are per task (`BENCH_MAX_RETRIES`); cancellation marks queued tasks cancelled and lets running tasks finish with their results discarded. | Predictable priority with per-benchmark fairness and no disruptive preemption. |
| D23 | **Visibility is group-tied at upload time.** A package is visible to its owner, the owner's group (so group members can select professor/phd packages), and admins. Moving a user to another group does not move the package. `GET /compressors` returns the flat `{name: options}` map with built-ins and visible ready packages merged. | Matches the "research group" visibility model and keeps the frontend contract unchanged. |
| D24 | **Custom compressor CSV is parsed leniently**: `memory_usage`, `random_access_ns`, `random_access_mbs` and `range_query_*` may be empty and are stored as `NULL`; the platform does not run the Massif/MemoryHarness measurement on user programs. | "Leave NULL unless self-reported" avoids misleading zeros in rankings. |
| D25 | **CPU information on `GET /status`** via `gopsutil` (cached static fields, live load per request): model, physical/logical cores, MHz, load 1/5/15, derived utilization, instruction-set flags. Shown on the Status page so users can pick safe `-march=native`/SIMD targets. | Needed by the compressor-package documentation and useful operationally. |

---

## 2. Architecture & Job Model

### 2.1 Components

```
┌────────────┐    ┌─────────────┐    ┌──────────────────────────┐
│ Frontend   │──▶ │ Backend     │──▶ │ PostgreSQL               │
│ (Vite/React)│   │ (Go + routy)│    │  users, groups,          │
└────────────┘    │             │    │  benchmarks, results,    │
┌────────────┐    │  - handlers │    │  compressor_packages     │
│ Admin FE   │──▶ │  - task     │    └──────────────────────────┘
│ (separate) │    │   scheduler │    ┌──────────────────────────┐
└────────────┘    │  - C++ bin  │──▶ │ Redis (JWT blocklist +   │
                  │    subprocess│   │  rate limiting)          │
                  └──────┬──────┘    └──────────────────────────┘
                         │ spawns (docker.sock)
          ┌──────────────┴────────────────┐
          ▼                               ▼
  ┌──────────────────┐         ┌──────────────────────┐
  │ LosslessBenchmark│         │ Runner container     │
  │ (C++ binary,     │         │ (untrusted user code:│
  │  image-built)    │         │  build + benchmark)  │
  │ -c <compressors> │         │ no network, non-root,│
  │ -o <out.csv>     │         │ cpu/mem/pids limits  │
  └──────────────────┘         └──────────────────────┘
```

### 2.2 Benchmark job state machine

```
            ┌─────────┐  claim (SKIP LOCKED)   ┌────────────┐
 upload ──▶ │ queued  │ ─────────────────────▶ │ in_progress│
            └─────────┘                        └─────┬──────┘
                ▲                                   │
                │ retry (≤ BENCH_MAX_RETRIES)       │
                │                                   ├─ exit 0 ──▶ parse CSV ──▶ ┌───────┐
                │                                   │                            │ ready │
                │                                   ├─ timeout (124) ──▶ ┌───────┐  └───┬───┘
                │                                   │                     │timed_ │      │ delete files
                │                                   ├─ non-zero ─▶ retry  │ out   │
                │                                   │                     └───────┘
                │                                   └─ admin cancel ──▶ ┌──────────┐
                │                                                        │cancelled │
                └────────────────────────────────────────────────────────┴──────────┘
                                                                         ┌────────┐
                                          retries exhausted ───────────▶ │ failed │
                                                                         └────────┘
```

- `queued`: row inserted on upload; claimable by the runner.
- `in_progress`: at least one of its tasks is running (`started_at` set on the first claim).
- `ready`: CSV parsed, `benchmark_results` rows inserted, `finished_at` set, files deleted.
- `failed`: subprocess exited non-zero and retries exhausted (`error` column set).
- `timed_out`: subprocess killed by `timeout` (exit 124) (`error` set).
- `cancelled`: admin cancelled a queued/in_progress job.

### 2.3 File lifecycle (per benchmark)

1. **Upload** → validate types + sizes (`MAX_FILE_SIZE_MB` per file, repeated `files` allowed) → normalize **synchronously at upload** to `.bin` under `DATA_DIR/<benchmark_id>/inputs/<i>/` (CSV → one `.bin` per column; zip/tar → one per member; `.bin` copied) → compute the combined MD5 over all file contents → insert the `benchmarks` row plus one `benchmark_tasks` row per unit of work (`status='queued'`) → delete the source uploads. Duplicate checksums are allowed.
2. **Claim** → the scheduler marks the best-fitting task `running` and (on the first claim) the benchmark `in_progress`, `started_at`.
3. **Run** → per task: a built-in task runs every selected built-in compressor for its `.bin` via the image-built binary (`-c <names> -o <out.csv>` under `timeout BENCH_TIMEOUT_SECONDS`) plus that `.bin`'s memory harness; a custom task runs one package against one `.bin` in a sandboxed runner container (`internal/runner`).
4. **Task result** → parsed rows are stored as JSONB on the task (`result`). Built-in output is parsed strictly; custom output leniently (empty optional metrics → `NULL`).
5. **Finalize** → once **all** tasks of a benchmark are terminal, the finalizing worker averages every task's rows into **one row per compressor**, inserts `benchmark_results`, sets `ready`/`finished_at`, deletes the task rows and `DATA_DIR/<benchmark_id>/`. A task failure fails the benchmark (queued siblings are cancelled; running siblings finish and are discarded); a timeout sets `timed_out`.
6. Built `compressor_packages` workspaces persist in `COMPRESSOR_DIR` until the package is deleted or replaced.

### 2.4 Concurrency, priority and fair share

- `MAX_PARALLELISM` is a **single CPU worker budget** (default: allocatable cores). The scheduler keeps `running_units <= budget`; each task declares its cost (built-in = 1, custom = package `workers`).
- A single scheduler loop claims tasks while free units remain: `SELECT ... FROM benchmark_tasks t JOIN benchmarks b ... WHERE t.status='queued' AND b.status IN ('queued','in_progress') AND t.workers <= <free> ORDER BY group.priority DESC, <running units per benchmark> ASC, t.created_at ASC LIMIT 1`; the benchmark row is locked before the task row (`finalize` uses the same lock order).
- The claim picks the **best-fitting** task, so a large custom task waits while smaller tasks keep the pool busy; higher-priority work never preempts running tasks.
- **Crash recovery:** at startup, tasks left `running` are re-queued (`ResetRunning`) and `in_progress` benchmarks whose tasks are all terminal are finalized (`ListStrandedInProgress`).
- **Cancellation:** `benchmarks.Cancel` marks the benchmark and its queued tasks `cancelled`; running tasks finish and their results are discarded before cleanup.

### 2.5 Redis usage

- **JWT blocklist**: on logout, `SET jwt_blocklist:<jti> 1 EX <remaining_ttl>`. Every protected request checks `EXISTS jwt_blocklist:<jti>`.
- **Rate limiting**: login (5/min/IP), upload (10/min/user). Token-bucket or fixed window in Redis.
- Redis data is **ephemeral** (no persistent volume required).

---

## 3. Frontend Specifications

- **Tech stack:** Vite, React, TypeScript, Tailwind CSS, Shadcn UI.
- **State management:** Zustand ONLY if cross-component state is required (e.g. benchmark selection on the compare page).
- **Charting:** Recharts.
- **Styling guide:** Reuse/adapt general-purpose React components and utilities from `reference/budgeteer` where applicable. Desktop-first; UI MUST NOT break on mobile.
- **Core responsibilities:** accept workloads, show the work queue, present results.

### 3.1 Pages

#### 3.1.1 Login page
- Email + password form; error states; loading state. No "register" link (staff-created accounts only, D1). If SMTP is enabled, show a "forgot password" link; if disabled, hide it.

#### 3.1.2 Main / upload page
- Brief platform introduction.
- Brief instructions on accepted file types and structure (see §4.5).
- **Benchmark name** input.
- **Upload / drag-and-drop area** with client-side validation (extension + size from `GET /api/v1/config.maxFileSizeMb`). Multiple files allowed; the list shows at most five rows and scrolls beyond that, with a per-file remove button and a "remove all" action.
- **Multi-file mode**: *Average* sends all files in one request as repeated `files` fields (one benchmark, tasks fan out, results averaged into one row per compressor); *Run separate benchmarks* enqueues one benchmark per file.
- **Run button** (disabled until name + valid file + compressors selected).
- **Advanced Options accordion**: for each compressor from `GET /api/v1/compressors`, render its option fields. Rule:
  - Range option with **≤ 20** steps → **slider**.
  - Range option with **> 20** steps → **number input** (min/max enforced).
  - `boolean` → switch. `select` → dropdown.
  - User-provided packages (merged into the same response) are grouped in a **Custom** family at the top of the compressor list.
- Duplicate checksums are allowed (D6); no client-side duplicate blocking. `GET /api/v1/benchmarks/checksums` is retained for backwards compatibility.

#### 3.1.3 Results page
- Top-center search bar (search by benchmark name).
- Square benchmark **cards**: name, file size, **status pill** (`queued` = blue, `in_progress` = yellow, `ready` = green) with a pulsing dot for non-ready states, upload datetime, started-at datetime, finished-at datetime.
- **Compressor pills** (tag style, bottom-center): show up to 5; if more, show `+N other` with the full list on hover.

#### 3.1.4 Benchmark detail page
Reproduces `final_results.html` for the single benchmark. See §3.4 for the exact chart set.

#### 3.1.5 Compare page
- Select up to 5 benchmarks.
- Render the same chart set as the detail page, overlaid/merged across the selected benchmarks (the `dataset`/benchmark dimension becomes the group key).

#### 3.1.6 Status page
- Work-queue depth, benchmark runner status, submitted-job statistics (counts by status). Data from `GET /api/v1/status`.
- **CPU section** (polls every 5s): model, physical/logical cores, MHz, 1/5/15-minute load average, derived utilization, and the available instruction sets (notable SIMD flags as badges plus the full flag list).

#### 3.1.7 Compressors page
- Lists the compressor packages visible to the current user (own group + own + all for admin).
- **Upload button is always visible but disabled for `student`**; the server enforces `admin`/`professor`/`phd` on upload.
- Upload form: `.zip` package; admins additionally choose an optional visibility group (no group → admins only).
- Table: name, version, language, workers, **status pill** (`building` yellow with pulsing dot, `ready` green, `failed` red + error), updated timestamp, actions.
- Packages in `building` state are polled every 3s; failed packages expose their build log; delete is available to the owner, an admin, or a professor of the same group.
- Custom packages appear in the benchmark upload page under the **Custom** family and render their `spec.yaml` options with the standard widget rules.

### 3.2 Admin frontend (decoupled)

- Separate Vite project + separate Docker service (see §7). Same tech stack.
- Simple CRUD: **users** (create, list, change role, assign group, reset password, delete), **groups** (create, list, set priority, delete), **benchmarks** (list across all users, cancel in-progress, delete).
- **Role-gated:** `admin` sees all pages; `professor` sees only Users and is scoped to their own group (create/delete/reset `student`/`phd` users, cannot touch peers, groups or priorities). `phd`/`student` cannot access the management app.
- Talks to `/api/v1/admin/*` with the same JWT scheme; the server-side scope checks are authoritative (D19).

### 3.3 Compressor-options widget schema

`GET /api/v1/compressors` returns:

```json
{
  "bzip2": {
    "block_size": { "type": "number", "min": 1, "max": 9, "default": 6, "step": 1 }
  },
  "gzip": {
    "level": { "type": "number", "min": 1, "max": 9, "default": 6, "step": 1 }
  },
  "falcon": {
    "mode": { "type": "select", "options": ["fast", "optimal"], "default": "fast" },
    "enabled": { "type": "boolean", "default": true }
  }
}
```

- `type` ∈ `{"number","boolean","select"}`.
- `number` fields carry `min`, `max`, `default`, optional `step`. Render slider if `(max-min)/step ≤ 20`, else number input.
- `boolean` → switch. `select` → dropdown.
- The built-in registry is static Go code (§6.2). The example above is illustrative; the agent MUST infer the real options from the C++ sources.
- Ready user-provided packages visible to the caller are merged into the same flat `{name: {option: Option}}` map (D23). Their options come from `spec.yaml` and follow the same schema, so the widget rules apply unchanged; a package with no options maps to `{}`.

### 3.4 Detail page — exact chart set (full parity with `final_results.html`)

At the top: a **Top-5 summary** (§3.5). Below it, in order:

1. **Overview grouped bar** — `compression_ratio` (%) per compressor. (On the detail page this is a single group; on the compare page it is grouped by benchmark.)

2. **Per-metric accordion sections**, one per metric, each containing:
   - a **chart** (bar for ratio/memory/latency metrics; scatter vs `compression_ratio` (%) for throughput/latency metrics), and
   - a **ranked table** (rows = dataset/benchmark, columns = compressors, ranked best/2nd/3rd).

3. **Pareto scatter plots** — each throughput/latency metric vs `compression_ratio` (%), one marker per compressor, colored + shaped by compressor family (§6.4 family table).

Metrics (in order) and their ranking direction:

| Metric | Chart | Ranking |
|:--|:--|:--|
| `compression_ratio` | grouped bar (×100, %) | **lower is better** |
| `compression_throughput_mbs` | scatter vs ratio | higher is better |
| `decompression_throughput_mbs` | scatter vs ratio | higher is better |
| `memory_usage` | grouped bar (MB) | **lower is better** |
| `compressor_internal` | grouped bar (MB) | **lower is better** |
| `relative_memory_usage` | grouped bar | **lower is better** |
| `internal_memory_ratio` | grouped bar | **lower is better** |
| `random_access_ns` | grouped bar + scatter vs ratio | **lower is better** |
| `random_access_mbs` | scatter vs ratio | higher is better |
| `range_query_<N>` (dynamic, one per range column in the CSV) | scatter vs ratio | higher is better |

A metric section is rendered **only if the column exists** in the results (e.g. `compressor_internal` is present only when a `memory.csv` override was produced).

Ranking visual rules (same as the HTML report): best = **bold**, 2nd = <u>underline</u>, 3rd = *italic*. Footer row shows per-compressor averages with the same ranking.

### 3.5 Top-5 summary — composite Pareto score

For a benchmark's result rows, compute per compressor `c`:

1. Objectives: `ratio_c = compression_ratio` (minimize), `tp_c = compression_throughput_mbs` (maximize).
2. **Domination**: compressor `a` **dominates** `b` iff `(ratio_a ≤ ratio_b AND tp_a ≥ tp_b)` AND at least one inequality is strict. If `tp` is NULL/NaN for all compressors, fall back to single-objective: `a` dominates `b` iff `ratio_a < ratio_b`.
3. `domination_count_c` = number of compressors that dominate `c`.
4. Sort by `(domination_count_c ASC, ratio_c ASC)`.
5. **Top 5** = the first 5 compressors in that order. Display compressor name, `compression_ratio` (%), `compression_throughput_mbs`, and a "Pareto-optimal" badge for those with `domination_count == 0`.

### 3.6 Frontend routing convention

- Backend is queried via `GET /api/v1/RESOURCE` and mutations via `POST`/`PUT`/`DELETE` to `/api/v1/...`.
- All requests (except `login`, `health`, `config`) carry `Authorization: Bearer <JWT>`.

---

## 4. Backend Specifications

- **Tech stack:** Go 1.26+, `github.com/skipperoo/routy` router, PostgreSQL (plain, pg18), Redis 7, Docker SDK (`internal/runner`).
- **Module path:** `bitbench`.
- **Package layout**:
  `internal/{config,logger,middleware,handler,service,repository,model,worker,compressor,runner}` and `cmd/bitbench-backend/main.go`.

### 4.1 Router setup (`routy`)

Public (no auth), protected (JWT + Redis blocklist + DB-resolved user), admin (protected + role guard). Protected mounted under `/api/v1/`, admin under `/api/v1/admin/` — distinct prefixes to avoid Go ServeMux pattern conflicts. Role authorization uses `middleware.RequireAdmin`, `middleware.RequireAdminOrProfessor` and `middleware.RequireUploader` applied per handler, so professor-scoped routes and admin-only routes share the `/api/v1/admin/` prefix.

**[DECISION D15]** The spec originally suggested both subroutes under `/api/`, but `net/http.ServeMux` panics when two `Handle()` calls share the same prefix. Protected routes use handler paths without `/v1/` prefix (e.g. `/auth/logout` → full path `/api/v1/auth/logout`). Admin routes use handler paths without `/v1/admin/` prefix (e.g. `/users` → `/api/v1/admin/users`). Handlers extract path parameters via `r.PathValue("id")` (Go 1.22+ ServeMux native path params) rather than manual `extractID()` — the subrouter's `http.StripPrefix` changes `r.URL.Path` from the full path to the subroute-relative path, so prefix-based extraction would fail.

**`cmd/bitbench-backend/main.go`**

```go
package main

import (
    "context"
    "log"
    "net/http"

    "github.com/skipperoo/routy"
    "bitbench/internal/handler"
    "bitbench/internal/middleware"
    "bitbench/internal/worker"
)

func main() {
    logger.InitLogger()
    defer logger.CloseLogger()

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // ... database + redis connections ...

    recoverMw := routy.NewRecoverMiddleware(nil)
    loggingMw := routy.NewLoggingMiddleware(middleware.StructuredLogger)

    // --- Public routes (no auth) ---
    router := routy.NewRouter()
    router.
        AddMiddleware(recoverMw.GetMiddleware()).
        AddMiddleware(loggingMw.GetMiddleware()).
        AddHandler("POST /api/v1/auth/login",   handler.Login).
        AddHandler("GET  /api/v1/health",       handler.HealthCheck).
        AddHandler("GET  /api/v1/config",       handler.GetConfig) // {maxFileSizeMb, smtpEnabled}

     // --- Protected routes (JWT + Redis blocklist + DB-resolved user) ---
    protected := routy.NewRouter()
    protected.
        AddMiddleware(middleware.JWTAuth).
        AddMiddleware(middleware.ResolveUser).
        AddHandler("POST  /auth/logout",           handler.Logout).
        AddHandler("PUT   /auth/password",         handler.ChangePassword).
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
        AddHandler("GET   /benchmarks/{id}/status",handler.GetBenchmarkStatus).
        AddHandler("GET   /benchmarks/compare",    handler.CompareBenchmarks). // ?ids=a,b,...
        AddHandler("GET   /status",                handler.GetStatus)

    // --- Admin/staff routes (JWT + DB-resolved user; per-route role guards) ---
    admin := routy.NewRouter()
    admin.
        AddMiddleware(middleware.JWTAuth).
        AddMiddleware(middleware.ResolveUser).
        AddHandler("POST   /users",                middleware.RequireAdminOrProfessor(handler.AdminCreateUser)).
        AddHandler("GET    /users",                middleware.RequireAdminOrProfessor(handler.AdminListUsers)).
        AddHandler("PUT    /users/{id}",           middleware.RequireAdminOrProfessor(handler.AdminUpdateUser)).   // role, group, reset password
        AddHandler("DELETE /users/{id}",           middleware.RequireAdminOrProfessor(handler.AdminDeleteUser)).
        AddHandler("POST   /groups",               middleware.RequireAdmin(handler.AdminCreateGroup)).
        AddHandler("GET    /groups",               middleware.RequireAdminOrProfessor(handler.AdminListGroups)).
        AddHandler("PUT    /groups/{id}",          middleware.RequireAdmin(handler.AdminUpdateGroup)).  // priority
        AddHandler("DELETE /groups/{id}",          middleware.RequireAdmin(handler.AdminDeleteGroup)).
        AddHandler("GET    /benchmarks",           middleware.RequireAdmin(handler.AdminListBenchmarks)).
        AddHandler("DELETE /benchmarks/{id}",      middleware.RequireAdmin(handler.AdminDeleteBenchmark)).
        AddHandler("POST   /benchmarks/{id}/cancel", middleware.RequireAdmin(handler.AdminCancelBenchmark))

    router.AddSubroute("/api/v1/", protected.Finalize())
    router.AddSubroute("/api/v1/admin/", admin.Finalize())
    final := router.Finalize()

    // --- Compressor package runner (Docker SDK over the mounted socket) ---
    // Builds/runs user packages in sandboxed containers; nil when unavailable.
    dockerRunner, _ := runner.NewDockerRunner(cfg.RunnerImage, cfg.RunnerMemoryMB, cfg.RunnerPidsLimit)
    if dockerRunner != nil {
        service.App.Compressor.SetRunner(dockerRunner)
    }

    // --- Background workers ---
    benchRunner := worker.NewBenchmarkRunner(cfg, db)   // task scheduler over the CPU worker budget
    if dockerRunner != nil {
        benchRunner.SetContainerRunner(dockerRunner)
    }
    go benchRunner.Run(ctx)
    go worker.NewEmailDispatcher(cfg, db).Run(ctx)   // no-op when SMTP disabled

    server := &http.Server{
        Addr:              ":8080",
        Handler:           final,
        ReadHeaderTimeout: 10 * time.Second,
        ReadTimeout:       60 * time.Second,
        WriteTimeout:      60 * time.Second,
        IdleTimeout:       120 * time.Second,
    }
    // ... graceful shutdown on SIGTERM; close DB + Redis ...
    log.Fatal(server.ListenAndServe())
}
```

> Bug fix: the original example had `GET /v1/bechmarks/{id}` (missing `n`), launched Budgeteer workers (`NewEmailDispatcher`, `NewJobCron`), and used `/api/` for both subroutes (causes ServeMux panic). All corrected above.

**`internal/middleware/auth.go`** (JWT; claims attached to context; Redis blocklist checked every request):

```go
func JWTAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        raw := r.Header.Get("Authorization")
        if raw == "" || !strings.HasPrefix(raw, "Bearer ") {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        token := strings.TrimPrefix(raw, "Bearer ")
        claims, err := jwt.Validate(token)
        if err != nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        if redis.IsBlocked(r.Context(), claims.ID) {
            http.Error(w, "token revoked", http.StatusUnauthorized)
            return
        }
        ctx := context.WithValue(r.Context(), middleware.ClaimsKey, claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// ResolveUser replaces the JWT role/group claims with current DB values so
// role/group changes and deletions take effect immediately.
func ResolveUser(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        claims := ClaimsFromContext(r.Context())
        if claims == nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        user, err := userLookup.FindByID(r.Context(), uuid.MustParse(claims.Sub))
        if err != nil || user == nil {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }
        ctx := context.WithValue(r.Context(), middleware.UserKey, user)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func requireRole(roles ...string) func(http.HandlerFunc) http.HandlerFunc {
    return func(next http.HandlerFunc) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
            user := UserFromContext(r.Context())
            if user == nil {
                http.Error(w, "forbidden", http.StatusForbidden)
                return
            }
            for _, role := range roles {
                if user.Role == role {
                    next(w, r)
                    return
                }
            }
            http.Error(w, "forbidden", http.StatusForbidden)
        }
    }
}

func RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
    return requireRole(model.RoleAdmin)(next)
}

func RequireAdminOrProfessor(next http.HandlerFunc) http.HandlerFunc {
    return requireRole(model.RoleAdmin, model.RoleProfessor)(next)
}

func RequireUploader(next http.HandlerFunc) http.HandlerFunc {
    return requireRole(model.RoleAdmin, model.RoleProfessor, model.RolePhD)(next)
}
```

**[DECISION D19]** Roles are resolved from the DB, never from JWT claims. `RequireAdmin` therefore checks `middleware.UserFromContext`, so a demoted admin or a deleted user loses access immediately. The admin subrouter no longer applies a blanket `RequireAdmin` middleware; each route carries its own guard (users: admin/professor, groups and benchmarks: admin).

### 4.2 JWT

- Algorithm: HS256; secret from Docker secret `jwt_secret`.
- Claims: `{ "sub": <user_id>, "email": <email>, "role": <"admin"|"professor"|"phd"|"student">, "group_id": <uuid|null>, "jti": <uuid>, "exp": <unix> }`. The claim is informational only for authorization: `middleware.ResolveUser` replaces it with the current DB row.
- Expiry: `JWT_EXPIRY` env (default `24h`).
- `jti` is the blocklist key.

### 4.3 API table

#### Public

| Method | Endpoint | Description |
|:--|:--|:--|
| `POST` | `/api/v1/auth/login` | Body `{email, password}` → `{token}`. Rate-limited 5/min/IP. |
| `GET`  | `/api/v1/health` | `{status:"ok"}`. |
| `GET`  | `/api/v1/config` | `{maxFileSizeMb, smtpEnabled}`. Public so the upload form can pre-validate. |

#### Protected (all authenticated users)

| Method | Endpoint | Description |
|:--|:--|:--|
| `POST` | `/api/v1/auth/logout` | Blocklist the current JWT (`jti`, TTL = remaining lifetime). |
| `PUT`  | `/api/v1/auth/password` | Body `{current_password, new_password}`; update `password_hash`; issue a fresh JWT. |
| `GET`  | `/api/v1/me` | Current user profile + group. |
| `GET`  | `/api/v1/compressors` | Compressor-options registry (§3.3 / §6.2) merged with visible ready package options (D23). |
| `POST` | `/api/v1/compressors/packages` | Multipart `file` (`.zip`); optional `group_id` for admins. `admin`/`professor`/`phd` only. Returns `202` + the package in `building` state; build runs asynchronously. |
| `GET`  | `/api/v1/compressors/packages` | Packages visible to the caller (own + own group + all for admin). |
| `GET`  | `/api/v1/compressors/packages/{id}` | Package details incl. status, error and build log. |
| `DELETE` | `/api/v1/compressors/packages/{id}` | Delete a package (owner, admin, or professor of the same group). |
| `GET`  | `/api/v1/benchmarks/checksums` | `[{"checksum":"<md5>"}, ...]` retained for backwards compatibility (duplicates are allowed, D6). |
| `POST` | `/api/v1/benchmarks` | Multipart: `name`, repeated `files` (legacy `file` accepted), `compressors` (JSON: `{"<name>": {<option>: <value>}, ...}`). Validates type/size, normalizes every file to `.bin` synchronously (long per-request write deadline), creates the `queued` benchmark plus its task rows. Compressor names must be built-ins or ready packages visible to the user. |
| `GET`  | `/api/v1/benchmarks` | `?q=<name>&status=<...>&page=<n>&size=<n>` → paginated card data. |
| `GET`  | `/api/v1/benchmarks/{id}` | Full results: all `benchmark_results` rows + selected compressors + metadata. |
| `GET`  | `/api/v1/benchmarks/{id}/status` | `{status, started_at, finished_at, error?}`. |
| `GET`  | `/api/v1/benchmarks/compare` | `?ids=a,b,c,d,e` (≤ 5) → merged results for the compare page. |
| `GET`  | `/api/v1/status` | `{queue_depth, runner:{running, max_parallelism}, stats:{queued, in_progress, ready, failed, timed_out, cancelled}, cpu:{model, physical_cores, logical_cores, mhz, load1, load5, load15, utilization, flags}}`. |

#### Admin / staff (`admin` + `professor` where noted)

| Method | Endpoint | Roles | Description |
|:--|:--|:--|:--|
| `POST`   | `/api/v1/admin/users` | admin, professor | Body `{email, password, role, group_id?}`. Create a user (professor: forced to own group, roles `student`/`phd` only). |
| `GET`    | `/api/v1/admin/users` | admin, professor | List users (professor: own group only). |
| `PUT`    | `/api/v1/admin/users/{id}` | admin, professor | Body `{role?, group_id?, reset_password?}`. Professor: same group, subordinate roles only, no group change. |
| `DELETE` | `/api/v1/admin/users/{id}` | admin, professor | Soft-delete a user (professor: own group, subordinate roles; self-delete blocked). |
| `POST`   | `/api/v1/admin/groups` | admin | Body `{name, priority}`. |
| `GET`    | `/api/v1/admin/groups` | admin, professor | List groups (professor: own group only). |
| `PUT`    | `/api/v1/admin/groups/{id}` | admin | Body `{name?, priority?}`. |
| `DELETE` | `/api/v1/admin/groups/{id}` | admin | Delete group (users' `group_id` → NULL). |
| `GET`    | `/api/v1/admin/benchmarks` | admin | List all benchmarks across users. |
| `DELETE` | `/api/v1/admin/benchmarks/{id}` | admin | Delete a benchmark + its results. |
| `POST`   | `/api/v1/admin/benchmarks/{id}/cancel` | admin | Set a `queued`/`in_progress` benchmark to `cancelled`. |

### 4.4 Background workers

#### Benchmark Task Scheduler (the core worker)
One scheduler loop plus one goroutine per running task, with an in-process counter of running worker units. Each iteration:
1. Compute `free = MAX_PARALLELISM - running_units`; claim the best-fitting queued task via `internal/repository.BenchmarkTaskRepository.ClaimNext` (priority DESC, fewest running units per benchmark, FIFO, `t.workers <= free`). The transaction locks the benchmark row **before** the task row to match `finalize`.
2. Launch the task with `runTask`; release the units and signal the scheduler when it finishes.
3. Built-in task: `timeout $BENCH_TIMEOUT_SECONDS $BENCH_BINARY -c <builtins> -o <out.csv> <file.bin>` plus `MemoryHarness` for that same `.bin`; parse strictly; store rows JSONB on the task.
4. Custom task: merge options, run the package entrypoint in a runner container (offline, non-root, `--cpus=workers`, throttling above the quota kills + fails); parse leniently; store rows JSONB on the task.
5. `finalize` runs after every terminal task: under the benchmark row lock, if no queued/running tasks remain it averages every task's rows, inserts `benchmark_results`, sets `ready`/`finished_at`, deletes the task rows and `DATA_DIR/<benchmark_id>/`. A failed task sets the benchmark `failed` and cancels queued siblings; a container/binary timeout sets `timed_out`.
6. On startup: `ResetRunning` re-queues interrupted tasks; `ListStrandedInProgress` finalizes benchmarks that crashed between the last task and aggregation.

#### Compressor Package Builder
- Triggered asynchronously after `POST /compressors/packages`: validates/extracts the archive, parses `spec.yaml`, then runs the optional build command (`make` when a `Makefile` exists) in a runner container **with no network** (all dependencies must be vendored).
- On success the package is `ready`; on failure `failed` with `error` and the build log; the Compressors page polls `building` packages every 3s.

#### Email Dispatcher
- Polls an `email_outbox` table (status=`pending`) and sends via SMTP. Increments `retry_count`; stops after 5 attempts (`status='failed'`).
- **If SMTP is not configured** (`SMTP_HOST` empty), the worker is a no-op and no `email_outbox` rows are written. Password reset is admin-only.

### 4.5 Data format & input validation

Accepted uploads:

- **`.bin`** — binary integer sequence. **TWO valid header formats** (auto-detected by file size, matching `compression/README.md`):
  - **Standard (16-byte header):** `uint64 N` + `uint64 decimals` + `N × int64` values. File size = `16 + 8N`.
  - **Simple (8-byte header):** `uint64 N` + `N × int64` values. File size = `8 + 8N`.
  - Validation: compute `N` from `(file_size - 16) / 8` and `(file_size - 8) / 8`; accept if either yields an exact integer ≥ 0. Reject otherwise.
- **`.csv`** — each column is a sequence; the backend materializes one `.bin` per column (16-byte header, `decimals=0`) and runs all; results averaged.
- **`.zip` / `.tar`** — containing multiple `.bin`; extract and run each; results averaged.

Client-side pre-checks (frontend): extension allow-list + size ≤ `MAX_FILE_SIZE_MB` (from `GET /api/v1/config`). Server-side re-checks the same and computes the MD5 (used for the stored filename); duplicate checksums are allowed (D6).

#### Filename-escaping rule (D5, unambiguous)
- Compute `md5 = MD5(file_bytes)` (hex, lowercase, 32 chars).
- `escaped = regex_replace(original_basename_without_ext, r"[^a-zA-Z0-9]", "_")` (collapse runs of non-alphanumerics into a single `_`; strip leading/trailing `_`).
- Stored filename: `{escaped}-{md5}.{ext}`. Example: `ECG gap!.bin` → `ECG_gap-<md5>.bin`.
- For `.zip`/`.tar`: the **archive** is stored as `{escaped}-{md5}.zip`; its inner `.bin` files keep their original names inside `DATA_DIR/<id>/` during normalization.

---

## 5. Database Schema

**Files:** `backend/internal/config/migrations/NNNN_description.sql`, embedded into the binary (`//go:embed`) and applied idempotently at backend startup by `config.RunMigrations` (tracked in `_migrations`). Plain PostgreSQL (D7). Uses `uuid-ossp`. Current chain: `0001_initial`, `0002_memory_columns`, `0003_progress_column`, `0004_polish` (drops the checksum uniqueness, adds `last_bench_config`), `0005_roles`, `0006_compressor_packages`, `0007_benchmark_tasks` (adds `benchmarks.file_count` and the task queue).

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- GROUPS (workload priority)
-- ============================================================
CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(100) UNIQUE NOT NULL,
    priority    INT NOT NULL DEFAULT 0,   -- higher = sooner
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USERS  (staff-created only; D1/D19)
-- ============================================================
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,           -- bcrypt or argon2id
    role          VARCHAR(10) NOT NULL DEFAULT 'student'
                  CHECK (role IN ('admin','professor','phd','student')),
    group_id      UUID REFERENCES groups(id) ON DELETE SET NULL,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    last_bench_config JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ                       -- soft delete; NULL = active
);

-- ============================================================
-- BENCHMARKS  (also the job queue; D3)
-- ============================================================
CREATE TABLE benchmarks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    file_size       BIGINT NOT NULL,                -- sum of all uploaded files
    file_count      INT NOT NULL DEFAULT 1,
    file_checksum   CHAR(32) NOT NULL,              -- MD5 hex; duplicates allowed (D6)
    file_ext        VARCHAR(10) NOT NULL,           -- 'bin','csv','zip','tar'
    status          VARCHAR(12) NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','in_progress','ready','failed','timed_out','cancelled')),
    compressors     JSONB NOT NULL,                  -- {"<name>": {<option>: <value>}}
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BENCHMARK RESULTS  (one averaged row per compressor; D6)
-- ============================================================
CREATE TABLE benchmark_results (
    id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    benchmark_id                    UUID NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    compressor                      VARCHAR(64) NOT NULL,
    dataset                         VARCHAR(128) NOT NULL,   -- normalized dataset/benchmark label
    num_values                      BIGINT,
    original_size                   BIGINT,
    memory_usage                    BIGINT,
    uncompressed_bits               BIGINT,
    compressed_bits                 BIGINT,
    compression_ratio               DOUBLE PRECISION,
    compression_throughput_mbs      DOUBLE PRECISION,
    decompression_throughput_mbs    DOUBLE PRECISION,
    random_access_ns                DOUBLE PRECISION,
    random_access_mbs               DOUBLE PRECISION,
    range_queries                   JSONB,                   -- {"<range>": <mbs>, ...}
    UNIQUE (benchmark_id, compressor)
);

-- ============================================================
-- BENCHMARK TASKS  (parallel work queue, D22/D26/D27)
-- ============================================================
CREATE TABLE benchmark_tasks (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    benchmark_id UUID NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    seq          INT NOT NULL,
    kind         VARCHAR(16) NOT NULL CHECK (kind IN ('builtin', 'custom')),
    compressor   VARCHAR(64),               -- custom package name; NULL for builtin
    input_path   TEXT NOT NULL,             -- .bin path relative to DATA_DIR
    workers      INT NOT NULL DEFAULT 1 CHECK (workers >= 1),
    status       VARCHAR(12) NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    result       JSONB,                     -- []BenchmarkRow produced by this task
    error        TEXT,
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (benchmark_id, seq)
);

-- ============================================================
-- COMPRESSOR PACKAGES  (user-provided, D20-D23)
-- ============================================================
CREATE TABLE compressor_packages (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id         UUID REFERENCES groups(id) ON DELETE SET NULL,
    name             VARCHAR(64) UNIQUE NOT NULL,
    version          VARCHAR(32) NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    language         VARCHAR(16) NOT NULL DEFAULT '',
    entrypoint       TEXT NOT NULL,
    workers          INT NOT NULL DEFAULT 1 CHECK (workers >= 1),
    spec             JSONB NOT NULL,               -- full parsed spec.yaml
    status           VARCHAR(12) NOT NULL DEFAULT 'building'
                     CHECK (status IN ('building','ready','failed')),
    error            TEXT,
    archive_checksum CHAR(32) NOT NULL,
    built_path       TEXT,
    build_log        TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- EMAIL OUTBOX  (only used when SMTP enabled)
-- ============================================================
CREATE TABLE email_outbox (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    to_address    VARCHAR(255) NOT NULL,
    subject       VARCHAR(255) NOT NULL,
    body          TEXT NOT NULL,
    status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    retry_count   INT NOT NULL DEFAULT 0,
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX ON benchmarks (user_id, created_at DESC);
CREATE INDEX ON benchmarks (status, created_at) WHERE status = 'queued';   -- queue scan
CREATE INDEX ON benchmarks (file_checksum);
CREATE INDEX ON benchmark_results (benchmark_id, compressor);
CREATE INDEX ON email_outbox (status, scheduled_for) WHERE status = 'pending';
CREATE INDEX ON benchmark_tasks (benchmark_id, status);
CREATE INDEX ON benchmark_tasks (status, created_at) WHERE status = 'queued';
CREATE INDEX ON compressor_packages (owner_id);
CREATE INDEX ON compressor_packages (group_id);
CREATE INDEX ON compressor_packages (status) WHERE status = 'ready';
```

### Migration workflow

Incremental schema changes live in `backend/internal/config/migrations/` as `NNNN_description.sql`. They are embedded into the backend binary and applied automatically (idempotently, tracked in `_migrations`) at startup by `config.RunMigrations`. `backend/scripts/migrate.sh` is available for manual application outside the backend process (reads `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_NAME` from env, `db_password` from `/run/secrets/db_password`).

### Seeding

On first startup the backend idempotently creates the default admin `admin@bitbench.org` / `changeme` (role `admin`, `must_change_password = TRUE`) and a default group `default` (priority 0). The password MUST be changed on first login. Accounts created later set `must_change_password = FALSE`.

### Notes & constraints

- SMTP is optional: active only when `SMTP_HOST` is set. When off, the Email Dispatcher is a no-op and users cannot reset passwords via mail (admin resets).
- Groups set workload priority (D10).
- Files are ephemeral (D5): deleted after the benchmark finishes. Built compressor-package workspaces persist in `COMPRESSOR_DIR` until the package is deleted or replaced.

---

## 6. Compression Integration & Benchmark Runner

### 6.1 The C++ benchmark

Source: `compression/`. Build artifacts: `LosslessBenchmark` (minimal) and `LosslessBenchmarkFull` (with Squash). The Dockerfile builds both at image-build time (D9); the backend prefers `LosslessBenchmarkFull` when present, else `LosslessBenchmark`.

Available compressors (from `-h`): `neats, dac, rle_gef, u_gef_approximate, u_gef_optimal, b_gef_approximate, b_gef_optimal, b_star_gef_approximate, b_star_gef_optimal, gorilla, chimp, chimp128, tsxor, elf, camel, falcon, alp, pfordelta, gzip, bzip3` (and `bzip2`, `lz4`, `zstd`, `brotli`, `xz`, `snappy` in Full mode).

Invocation (the ONLY flags the backend uses):
```
$BENCH_BINARY -c <comma-separated-compressors> -o <out.csv> <file.bin>
```
With `LD_LIBRARY_PATH` pointing at the bundled Squash libraries when running Full. Timeout enforced by the `timeout` wrapper (`BENCH_TIMEOUT_SECONDS`).

### 6.2 Compressor-options registry (D8)

`internal/compressor/registry.go` exports a static `map[string]map[string]Option`. **To populate it the first time, the agent MUST:**

1. Read `compression/benchmark/lossless_benchmark.cpp` and every `compression/benchmark/<Name>/*.hpp` to find each compressor's configurable parameters (block sizes, levels, modes, thresholds).
2. For each parameter, record `type` (`number`/`boolean`/`select`), `min`, `max`, `default`, `step` (for numbers), or `options` (for `select`).
3. Encode the result in `registry.go`. `GET /api/v1/compressors` serializes this map, merged with the options of ready user packages visible to the caller (D23).
4. If a compressor exposes no tunable parameters, it maps to an empty option set and the frontend renders no option fields for it (just an enable checkbox).

### 6.3 Benchmark result CSV schema (the exact columns the backend parses)

Header emitted by `BenchmarkResult::print_header` (`lossless_benchmark.cpp:210`):

```
compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,
compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,
random_access_ns,random_access_mbs[,range_query_<N>...]
```

- The trailing `range_query_<N>` columns are **dynamic** (one per range size the binary probes). The parser MUST treat any column starting with `range_query_` as a range-query throughput (`mbs`, higher is better) and store them in `benchmark_results.range_queries` as `{"<N>": <value>}`.
- `compression_ratio = compressed_bits / uncompressed_bits` (lower is better). The frontend displays it as `%` (×100).
- Rows are grouped by `compressor`; when a benchmark produces multiple `.bin` files (CSV columns / zip contents), all rows for a compressor are **averaged** (numeric columns) into one stored row (D6). The `dataset` column of the stored row = the normalized benchmark label (original filename stem).
- **Built-in output is parsed strictly.** User-provided compressor output is parsed **leniently** (D24): all 12 columns must exist, but `memory_usage`, `random_access_ns`, `random_access_mbs` and unparseable/empty `range_query_*` cells are stored as `NULL`; when a metric is empty in *all* rows of a compressor it stays `NULL` after averaging.

### 6.4 Compressor families (for chart coloring/shaping, parity with the HTML report)

| Family | Members | Marker |
|:--|:--|:--|
| Block-sorting | bzip2, bzip3 | square |
| Dictionary-based | Brotli, gzip (1/6/9), lz4, Snappy, XZ, zstd | diamond |
| Time Series | ALP1, Camel, Chimp, Chimp128, Elf, Falcon, Gorilla, NeaTS, TSXor | circle |
| GEF | B*-GEF (Approx/Opt), B-GEF (Approx/Opt), RLE-GEF, U-GEF (Approx/Opt) | triangle-up |
| PForDelta | PForDelta | star |
| DAC | DAC | pentagon |

`rename_compressor`: `b_star_gef_approximate`→`B*-GEF (Approx)`, `gzip`→`Gzip`, `dac`→`DAC`, etc. (full map in `scripts/generate_full_html_report.py` and `frontend/src/lib/compressors.ts`).

### 6.5 Metric ranking rules (parity with `is_min_best`)

Lower is better: `compression_ratio`, `compressed_bits`, `uncompressed_bits`, `original_size`, `memory_usage`, `compressor_internal`, `internal_memory_ratio`, `relative_memory_usage`, `random_access_ns`, any `*_ns`, any `*_bits`.
Higher is better: everything else (throughputs `*_mbs`, range queries).

### 6.6 User-provided compressor packages (D20-D24)

A package is a `.zip` archive with `spec.yaml` at the root, its sources under `src/`, an optional `Makefile` (compiled languages) and optionally vendored dependencies. Full user documentation lives in `docs/user-compressors.md`; working examples in `examples/user-compressors/<language>/` (Python, C, C++, Go, Rust), E2E-tested in CI.

**`spec.yaml`**: `name` (`[a-z0-9_]{1,64}`, globally unique, no built-in collision), `version`, `description?`, `language?`, `entrypoint` (command relative to the package root), `workers` (default 1), optional `build.command`/`build.timeout_seconds`, and `options` (same schema as the built-in registry).

**Invocation** (executed in the runner container, working dir = package root):
```
<entrypoint> -o <out.csv> --<option>=<value>... --options <options.json> <input.bin>
```
Both forms are always passed; when both specify a key the JSON file wins.

**Build**: at upload, asynchronously, in the runner image, with **no network** — `build.command` or `make` when a `Makefile` exists. Artifacts live in `COMPRESSOR_DIR/<built_path>/pkg` on the `bitbench_compressor_data` volume. Success → `ready`, failure → `failed` with `error` + `build_log`.

**Sandbox** (build and run): image `RUNNER_IMAGE` (Debian + python3/pip, gcc/g++, Go, rustc/cargo), `--network none`, non-root (`uid 1000`) for runs, read-only rootfs with a `/tmp` tmpfs, memory `RUNNER_MEMORY_MB`, pids `RUNNER_PIDS_LIMIT`. Files are exchanged through the named volumes mounted at identical paths in backend and runner containers (D21). The runner never receives the Docker socket.

**Workers**: each custom `(bin × package)` task costs the package's declared `workers` units from the unified `MAX_PARALLELISM` budget (`workers <= budget` is validated at upload and run time) and gets `--cpus=workers`; cgroup throttling beyond `max(2s, 5% of runtime)` kills the container and fails the task (D22).

**Validation**: package size `MAX_PACKAGE_SIZE_MB` (default 50), uncompressed archive ≤ 20x, ≤ 5000 files, no symlinks/path traversal, entrypoint must exist and be executable after the build.

**Visibility** (D23): owner, owner's group at upload time, and admins. Benchmark creation accepts built-in names or ready packages visible to the requesting user.

---

## 7. Deployment (Docker)

Strict secret management: no sensitive credentials in env vars; secrets are files under `/run/secrets/`. **File:** `docker-compose.yml`.

```yaml
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "81:81"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - frontend
      - admin-frontend
      - backend
    restart: unless-stopped

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    develop:
      watch:
        - action: rebuild
          path: ./frontend
    expose:
      - "80"
    depends_on:
      - backend
    restart: unless-stopped

  admin-frontend:
    build:
      context: ./admin-frontend
      dockerfile: Dockerfile
    develop:
      watch:
        - action: rebuild
          path: ./admin-frontend
    expose:
      - "80"
    depends_on:
      - backend
    restart: unless-stopped

  runner:
    build:
      context: ./runner
      dockerfile: Dockerfile
    image: bitbench-runner:latest
    command: ["/bin/true"]
    restart: "no"

  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    develop:
      watch:
        - action: rebuild
          path: ./backend
        - action: rebuild
          path: ./compression/benchmark
        - action: rebuild
          path: ./compression/lib
    secrets:
      - jwt_secret
      - db_password
      - redis_password
      - smtp_password
    environment:
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_USER=bitbench
      - DB_NAME=bitbench
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - JWT_EXPIRY=24h
      # Total worker budget: defaults to the cores allocatable to this
      # container (cgroup-aware). Uncomment to pin an explicit cap.
      # - MAX_PARALLELISM=8
      - MAX_FILE_SIZE_MB=500
      - BENCH_TIMEOUT_SECONDS=3600
      - BENCH_MAX_RETRIES=2
      - DATA_DIR=/data/benchmarks
      - BENCH_BINARY_PATH=/app/bin/LosslessBenchmarkFull
      - COMPRESSOR_DIR=/data/compressors
      - MAX_PACKAGE_SIZE_MB=50
      - RUNNER_IMAGE=bitbench-runner:latest
      - RUNNER_MEMORY_MB=4096
      - RUNNER_PIDS_LIMIT=512
      - BUILD_TIMEOUT_SECONDS=600
      - BENCH_VOLUME=bitbench_bench_data
      - COMPRESSOR_VOLUME=bitbench_compressor_data
      - SMTP_HOST=${SMTP_HOST:-}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_USER=${SMTP_USER:-}
      - SMTP_FROM=${SMTP_FROM:-}
    volumes:
      - bench_data:/data/benchmarks
      - compressor_data:/data/compressors
      - /var/run/docker.sock:/var/run/docker.sock
    expose:
      - "8080"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
      runner:
        condition: service_completed_successfully
    restart: unless-stopped

  postgres:
    image: postgres:18-alpine
    secrets:
      - db_password
    environment:
      - POSTGRES_USER=bitbench
      - POSTGRES_DB=bitbench
      - POSTGRES_PASSWORD_FILE=/run/secrets/db_password
    volumes:
      - pg_data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bitbench"]
      interval: 10s
      timeout: 5s
      retries: 5
    expose:
      - "5432"
    restart: unless-stopped

  redis:
    image: redis:latest
    secrets:
      - redis_password
    command: >
      sh -c 'redis-server --requirepass "$$(cat /run/secrets/redis_password)"'
    expose:
      - "6379"
    restart: unless-stopped

volumes:
  bench_data:
    driver: local
    name: bitbench_bench_data
  compressor_data:
    driver: local
    name: bitbench_compressor_data
  pg_data:
    driver: local

secrets:
  jwt_secret:
    file: ./secrets/jwt_secret.txt
  db_password:
    file: ./secrets/db_password.txt
  redis_password:
    file: ./secrets/redis_password.txt
  smtp_password:
    file: ./secrets/smtp_password.txt
```

> Bug fix: the original compose omitted the `admin-frontend` service and used the TimescaleDB image; both corrected. Revision 3 adds the `runner` image service (no long-running process; it exists so `docker compose up --build` produces `bitbench-runner:latest`), the compressor volume and the Docker socket mount required by D21.

### Environment variables (complete reference)

| Variable | Default | Purpose |
|:--|:--|:--|
| `DB_HOST/PORT/USER/NAME` | — | Postgres connection. |
| `REDIS_HOST/PORT` | — | Redis connection. |
| `JWT_EXPIRY` | `24h` | JWT lifetime. |
| `MAX_PARALLELISM` | allocatable cores (`GOMAXPROCS`) | Total CPU worker budget (task scheduler, D22). |
| `MAX_FILE_SIZE_MB` | `500` | Upload size cap per file (frontend reads via `/config`). |
| `BENCH_TIMEOUT_SECONDS` | `3600` | Per-task subprocess/container timeout. |
| `BENCH_MAX_RETRIES` | `2` | Per-task failure retries. |
| `DATA_DIR` | `/data/benchmarks` | Ephemeral file workspace. |
| `BENCH_BINARY_PATH` | `/app/bin/LosslessBenchmarkFull` | Benchmark executable. |
| `COMPRESSOR_DIR` | `/data/compressors` | Persistent package/workspace root. |
| `MAX_PACKAGE_SIZE_MB` | `50` | Uploaded package `.zip` size cap. |
| `RUNNER_IMAGE` | `bitbench-runner:latest` | Sandbox image for builds and runs. |
| `RUNNER_MEMORY_MB` | `4096` | Per-container memory limit. |
| `RUNNER_PIDS_LIMIT` | `512` | Per-container pid limit. |
| `BUILD_TIMEOUT_SECONDS` | `600` | Default package build timeout. |
| `BENCH_VOLUME` | `bitbench_bench_data` | Named volume mounted at `DATA_DIR` in runner containers. |
| `COMPRESSOR_VOLUME` | `bitbench_compressor_data` | Named volume mounted at `COMPRESSOR_DIR`. Empty → bind mount (local dev). |
| `SMTP_HOST/PORT/USER/FROM` | empty | SMTP; empty `SMTP_HOST` disables mail. |

### Backend Dockerfile (multi-stage, D9)

```dockerfile
# Stage 1: Build Squash library
FROM gcc:13 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake wget bzip2 ninja-build ragel doxygen valac libglib2.0-dev && rm -rf /var/lib/apt/lists/*
RUN wget https://github.com/quixdb/squash/releases/download/v0.7.0/squash-0.7.0.tar.bz2 \
    && tar -xjf squash-0.7.0.tar.bz2 && rm squash-0.7.0.tar.bz2
WORKDIR /usr/src/squash-0.7.0
RUN mkdir build && cd build \
    && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. \
    && ninja && ninja install

# Stage 2: Build C++ artifacts
FROM gcc:13 AS cpp-build
COPY --from=builder /usr/local/lib /usr/local/lib
COPY --from=builder /usr/local/include /usr/local/include
COPY --from=builder /usr/local/bin /usr/local/bin
RUN ldconfig
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake pkg-config liblz4-dev libsnappy-dev && rm -rf /var/lib/apt/lists/*
COPY compression/ ./compression/
RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release -DNEATS_WITH_SQUASH=ON
RUN cd compression && make -j$(nproc) -C build LosslessBenchmarkFull MemoryHarness
RUN mkdir -p /artifacts/bin && \
    cp compression/build/LosslessBenchmarkFull /artifacts/bin/ && \
    cp compression/build/MemoryHarness /artifacts/bin/

# Stage 3: Build Go backend
FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ .
RUN CGO_ENABLED=0 go build -o /out/bitbench ./cmd/bitbench-backend

# Stage 4: Runtime
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libgomp1 libglib2.0-0 libsnappy1v5 libbrotli1 \
    valgrind time && rm -rf /var/lib/apt/lists/*
COPY --from=cpp-build /usr/local/lib/ /usr/local/lib/
RUN ldconfig
WORKDIR /app
COPY --from=go-build /out/bitbench /app/bitbench
COPY --from=cpp-build /artifacts/bin/ /app/bin/
EXPOSE 8080
CMD ["/app/bitbench"]
```

### Runner Dockerfile (`runner/Dockerfile`, D20-D22)

```dockerfile
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 python3-pip python3-venv \
    gcc g++ make cmake pkg-config golang-go rustc cargo \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 runner
ENV HOME=/tmp TMPDIR=/tmp GOCACHE=/tmp/go-build GOMODCACHE=/tmp/go/pkg/mod \
    GOPATH=/tmp/go CARGO_HOME=/tmp/cargo RUSTUP_HOME=/tmp/rustup
WORKDIR /pkg
USER runner
CMD ["/bin/true"]
```

---

## 8. Development Workflow

### 8.1 Branching strategy

`master` is the stable, deployable branch. **No one pushes directly to `master`.** Every unit of work lives in its own branch and enters `develop` via a pull request once all checks pass. Only humans promote `develop` to `master`.

Branch names: `<type>/<short-description>`.

| Type | When |
|:--|:--|
| `feature/` | New functionality (e.g. `feature/benchmark-runner`) |
| `fix/` | Bug fixes (e.g. `fix/checksum-duplicate-scope`) |
| `refactor/` | Internal restructuring, no behavior change |
| `migration/` | Database schema changes (e.g. `migration/add-groups-table`) |
| `chore/` | Tooling, dependencies, CI config |

### 8.2 Merge rules

A branch may merge into `master` only when **all** are true:
1. CI passes (build, lint, full test suite).
2. Every new feature/fix ships with its tests in the same branch and commit.
3. No pre-existing test was deleted or disabled to make the suite pass.

### 8.3 Testing requirements

Every PR introducing behavior MUST ship tests in the same commit.

**Backend (Go)**

| Layer | Tool | What to cover |
|:--|:--|:--|
| Unit | `testing` (stdlib) | CSV result parser (strict + lenient, dynamic range columns, missing-metric propagation through averaging incl. memory fields), MD5 checksum, filename-escaping rule, `.bin` 8-byte vs 16-byte header detection, job-state transition predicates, Pareto-score computation, compressor-option registry serialization, `spec.yaml`/option validation, zip extraction safety (traversal/symlink/size cap), custom invocation command builder, CPU status builder, role guards and `ResolveUser` |
| Integration | `testing` + `testcontainers-go` | Each handler (happy + error path) against real PostgreSQL + Redis; multi-file upload creates one benchmark + one task per `.bin`; login → logout + JWT blocklist eviction; role/scope matrix (professor group scoping, student 403, deleted-user token rejection); compressor package API (upload/list/visibility/replace/delete) with a fake runner; task claim ordering (priority, fewest-running fair share, worker fit, cancelled benchmarks); benchmark scheduler end-to-end with the **real runner image** (normalize → task fan-out → build/run → parse → average → `ready` → files deleted), including all `examples/user-compressors` packages and a multi-file averaging case |

Minimum per PR: new handler → ≥1 happy + ≥1 error integration test; new worker → unit test for the scheduling/claim predicate + integration test for the DB interaction; new migration → integration test against a fresh schema.

**Frontend (TypeScript)**

| Layer | Tool | What to cover |
|:--|:--|:--|
| Unit | Vitest | File-validation logic (type + size), option-form rendering rules (slider vs number input by step count), Pareto-score helper, ranking-direction helper, package status/manage helpers, CPU formatting/flags helpers |
| Component | React Testing Library | Upload form (valid/invalid/loading states), status pill states (`queued`/`in_progress`/`ready`), error states, advanced-options accordion, Compressors page (student-disabled upload, statuses, build log) |
| E2E | Playwright | Login, upload a benchmark, view detail charts, compare two benchmarks |

Minimum per PR: new UI component → component tests for its interactive states; new pure logic → unit tests with known input/output vectors; new user journey → happy-path Playwright test.

> Bug fix: the original spec copied Budgeteer's "crypto pipeline / LWW conflict resolver / offline queue / add transaction / joint account invite" test targets and the `NewEmailDispatcher`/`NewJobCron` example workers. BitBench has **no E2E crypto, no LWW, no offline queue, no transactions, no joint accounts** — all replaced with the BitBench targets above.

### 8.4 CI pipeline

`.github/workflows/ci.yml` runs on pushes to `master`/`develop` and on PRs targeting `master`:

```
1. Lint        — go vet ./... (Go), tsc --noEmit (TS, frontend + admin-frontend)
2. Unit tests  — go test ./internal/{compressor,model,middleware,service,worker}/... (Go), vitest run (frontend)
3. Integration — build the runner image (docker buildx + GitHub Actions layer cache),
                 then go test -tags=integration ./internal/handler/... ./internal/worker/...
                 (testcontainers PostgreSQL + Redis; real-Docker E2E that builds and
                 benchmarks every examples/user-compressors package)
4. Build       — go build (Go), vite build (TS, both frontend + admin-frontend)
```

All four gates must be green. A red pipeline blocks merge regardless of approvals.

---

## 9. Design Context

**Register:** product (app UI, dashboard, data analysis tool)
**North Star:** The Lab Bench — a precision instrument, not a decorative dashboard.
**Brand:** Precise · Technical · Confident. No-nonsense research tool.
**Anti-references:** No SaaS dashboard clichés (hero metrics, gradient cards), no consumer playfulness, no enterprise gray-on-gray.

For the full design system with color tokens, typography, component specs, and Named Rules see `PRODUCT.md` and `DESIGN.md` at the project root.
