# BitBench — Technical Specifications

> **Revision 2** — Supersedes Revision 1. Incorporates implementation decisions discovered during the build: subroute prefix conflict resolution (routy), postgres 18 volume layout, secret trimming, nginx resolver for dynamic upstream resolution, TS 6 `paths` without `baseUrl`. All design decisions are recorded inline (marked **[DECISION]**).
>
> **Revision 1** — Initial full specification produced by the audit/enrichment pass. This revision supersedes the original sketch and fixes every entry in `BACKLOG.md # BUGS`: the `/v1/bechmarks` route typo, the `admin`-role contradiction, all copy-pasted Budgeteer testing/worker content, the incomplete `.bin` format, the missing admin Docker service, the undefined max-file-size env var, the ambiguous filename-escaping rule, the missing compressor-options/checksum/results/compare/status endpoints, the missing database schema, the underspecified compressor-options source, and the too-vague detail-page chart reference. All design decisions are recorded inline (marked **[DECISION]**).

---

## 1. System Overview

BitBench is a compression-algorithm testing platform. A user (created by an admin) uploads a file containing one or more integer sequences, selects compressors and their options, and the platform runs the benchmark binary as a subprocess. The backend parses the CSV results, stores one **averaged row per compressor**, and the frontend renders ranked tables, bar charts, and Pareto scatter plots to rank the best compressors for that data.

**Target platforms:** Web (desktop-first, responsive down to mobile). No native apps.

**Out of scope:** open self-registration, end-to-end encryption, offline-first sync, time-series hypertables, OTP/email verification. BitBench is a server-authoritative, online-only tool.

### Design decisions (locked)

| # | Decision | Rationale |
|:-:|:--|:--|
| D1 | **Admin-created accounts only.** No `POST /auth/register`. Admin creates users from the admin panel. | Matches "SMTP optional; no password reset via mail." |
| D2 | **Auth = email + password + JWT.** No OTP, no E2E keypairs, no X25519. | BitBench has no sensitive per-user payload to encrypt. |
| D3 | **Job queue = PostgreSQL `benchmarks` table + `FOR UPDATE SKIP LOCKED`.** No separate `jobs` table; a row with `status='queued'` is the queue. | Durable, transactional with results, restart-safe, no extra moving parts. |
| D4 | **Backend normalizes all uploads to `.bin` before invoking the subprocess.** CSV → one `.bin` per column; zip/tar → extracted `.bin` files. | The benchmark binary only accepts `.bin`. |
| D5 | **Files are stored locally and DELETED when the benchmark finishes** (after results are parsed and persisted). | Ephemeral; re-running requires re-upload. |
| D6 | **One upload = one benchmark = one averaged result row per compressor.** "Runs once" = reject re-upload of the same MD5 checksum **globally**. | Matches the report's averaging model and the "runs only once" rule. |
| D7 | **Plain PostgreSQL** (`postgres:18-alpine`), not TimescaleDB. | No time-series data in BitBench. |
| D8 | **Compressor options = static Go registry** in `internal/compressor/registry.go`. The agent MUST first explore `compression/benchmark/*.cpp` and the compressor headers to infer each compressor's tunable parameters from its function/constructor parameters, then encode them. | The `-h` output only lists compressor names, not options. |
| D9 | **C++ artifacts built at backend image build time** via a multi-stage Dockerfile (CMake + make). | Reproducible, fast startup, no toolchain in the runtime image. |
| D10 | **Groups drive scheduling via an integer `priority`; strict higher-priority-first, FIFO within the same priority.** | Simple, predictable. |
| D11 | **Detail page = full parity with `final_results.html`**: overview bar + per-metric accordions (chart + ranked table) + Pareto scatter. | Faithful to the reference report. |
| D12 | **Top-5 summary = composite Pareto score** over (minimize `compression_ratio`, maximize `compression_throughput_mbs`). Formula in §3.5. | Balances size and speed. |
| D13 | **Reverse proxy = nginx** (`nginx:alpine`), config at `angie/nginx.conf`. Single entry point routing `/api/*` → backend, `/*` → frontend, port 81 → admin-frontend. | Standard nginx, well-known, simple configuration. |
| D14 | **Redis image = `redis:latest`** (not 7-alpine). | Simpler maintenance; pinning to `latest` is acceptable for this project's deployment scope. |
| D15 | **routy subroute prefix conflict resolution.** Protected routes mounted under `/api/v1/` (handler paths without `/v1/` prefix); admin routes mounted under `/api/v1/admin/` (handler paths without `/v1/admin/` prefix). Go's `ServeMux` panics if two subrouters share the same prefix. | Avoids `panic: pattern conflicts` at router finalization. |
| D16 | **Postgres 18 volume layout.** `pg_data` volume mounted at `/var/lib/postgresql` (not `/var/lib/postgresql/data`). Postgres 18+ uses major-version-specific subdirectory layout compatible with `pg_upgrade --link`. | Required by postgres:18-alpine entrypoint; old mount point causes startup failure. |
| D17 | **Secret trimming.** `readSecret()` in `config.go` trims whitespace via `strings.TrimSpace` before returning the value. Secret files created by `echo` include a trailing newline. | Avoids `invalid control character in URL` when building the Postgres DSN. |
| D18 | **Nginx dynamic upstream resolution.** The reverse proxy uses `resolver 127.0.0.11` (Docker's embedded DNS) with `set $upstream "backend:8080"; proxy_pass http://$upstream;` instead of static `proxy_pass http://backend:8080`. | Nginx resolves hostnames at startup; if the backend container isn't ready yet, nginx crashes. Dynamic resolution retries at request time. |

---

## 2. Architecture & Job Model

### 2.1 Components

```
┌────────────┐    ┌─────────────┐    ┌──────────────────────────┐
│ Frontend   │──▶ │ Backend     │──▶ │ PostgreSQL               │
│ (Vite/React)│   │ (Go + routy)│    │  users, groups,          │
└────────────┘    │             │    │  benchmarks, results     │
┌────────────┐    │  - handlers │    └──────────────────────────┘
│ Admin FE   │──▶ │  - runner   │    ┌──────────────────────────┐
│ (separate) │    │    pool (N) │──▶ │ Redis (JWT blocklist +   │
└────────────┘    │  - C++ bin  │    │  rate limiting)          │
                  │    subprocess│   └──────────────────────────┘
                  └──────┬──────┘
                         │ spawns
                         ▼
                  ┌──────────────────┐
                  │ LosslessBenchmark│ (C++ binary, image-built)
                  │ -c <compressors> │
                  │ -o <out.csv>     │
                  └──────────────────┘
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
- `in_progress`: a runner goroutine owns it (`started_at` set).
- `ready`: CSV parsed, `benchmark_results` rows inserted, `finished_at` set, files deleted.
- `failed`: subprocess exited non-zero and retries exhausted (`error` column set).
- `timed_out`: subprocess killed by `timeout` (exit 124) (`error` set).
- `cancelled`: admin cancelled a queued/in_progress job.

### 2.3 File lifecycle (per benchmark)

1. **Upload** → validate type + size (`MAX_FILE_SIZE_MB`) → compute MD5 → reject if checksum exists globally → insert `benchmarks` row (`status='queued'`) → write file to `DATA_DIR/<escaped-name>-<md5>.<ext>`.
2. **Claim** → runner sets `in_progress`, `started_at`.
3. **Normalize** → convert to one or more `.bin` under `DATA_DIR/<benchmark_id>/`.
4. **Run** → for each `.bin`, invoke the binary with `-c <selected_compressors>` and `-o <out.csv>`, under `timeout BENCH_TIMEOUT_SECONDS`.
5. **Parse** → read `<out.csv>`, average across all inner `.bin`/columns into **one row per compressor**.
6. **Persist** → insert `benchmark_results` rows.
7. **Finalize** → set `ready`, `finished_at`; delete `DATA_DIR/<benchmark_id>/` and the original uploaded file.

### 2.4 Concurrency & priority

- `MAX_PARALLELISM` goroutines each loop: `SELECT ... FROM benchmarks WHERE status='queued' ORDER BY group.priority DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`.
- On claim: `UPDATE benchmarks SET status='in_progress', started_at=NOW() WHERE id=$1 AND status='queued'` (guarded re-check inside the transaction).
- Each goroutine processes one benchmark end-to-end.

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
- Email + password form; error states; loading state. No "register" link (admin-created accounts only). If SMTP is enabled, show a "forgot password" link; if disabled, hide it.

#### 3.1.2 Main / upload page
- Brief platform introduction.
- Brief instructions on accepted file types and structure (see §4.5).
- **Benchmark name** input.
- **Upload / drag-and-drop area** with client-side validation (extension + size from `GET /api/v1/config.maxFileSizeMb`).
- **Run button** (disabled until name + valid file + compressors selected).
- **Advanced Options accordion**: for each compressor from `GET /api/v1/compressors`, render its option fields. Rule:
  - Range option with **≤ 20** steps → **slider**.
  - Range option with **> 20** steps → **number input** (min/max enforced).
  - `boolean` → switch. `select` → dropdown.
- **Duplicate check**: before upload, fetch `GET /api/v1/benchmarks/checksums`, compute the file MD5 client-side, and block the upload if it already exists.

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

### 3.2 Admin frontend (decoupled)

- Separate Vite project + separate Docker service (see §7). Same tech stack.
- Simple CRUD: **users** (create, list, change role, assign group, reset password, delete), **groups** (create, list, set priority, delete), **benchmarks** (list across all users, cancel in-progress, delete).
- Talks to `/api/v1/admin/*` (admin-role-guarded) with the same JWT scheme.

### 3.3 Compressor-options widget schema

`GET /api/v1/compressors` returns:

```json
{
  "bzip2": {
    "block_size": { "type": "number", "min": 1, "max": 9, "default": 6, "step": 1 }
  },
  "gzip_6": {
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
- The registry is static Go code (§6.2). The example above is illustrative; the agent MUST infer the real options from the C++ sources.

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

- **Tech stack:** Go 1.26+, `github.com/skipperoo/routy` router, PostgreSQL (plain, pg18), Redis 7.
- **Module path:** `bitbench`.
- **Package layout** (mirror the reference project):
  `internal/{config,logger,middleware,handler,service,repository,model,worker,compressor}` and `cmd/bitbench-backend/main.go`.

### 4.1 Router setup (`routy`)

Public (no auth), protected (JWT + Redis blocklist), admin (JWT + `role='admin'`). Protected mounted under `/api/v1/`, admin under `/api/v1/admin/` — distinct prefixes to avoid Go ServeMux pattern conflicts.

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

     // --- Protected routes (JWT + Redis blocklist) ---
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
        AddHandler("GET   /benchmarks/{id}/status",handler.GetBenchmarkStatus).
        AddHandler("GET   /benchmarks/compare",    handler.CompareBenchmarks). // ?ids=a,b,...
        AddHandler("GET   /status",                handler.GetStatus)

    // --- Admin routes (JWT + role='admin') ---
    admin := routy.NewRouter()
    admin.
        AddMiddleware(middleware.JWTAuth).
        AddMiddleware(middleware.RequireAdmin).
        AddHandler("POST   /users",                handler.AdminCreateUser).
        AddHandler("GET    /users",                handler.AdminListUsers).
        AddHandler("PUT    /users/{id}",           handler.AdminUpdateUser).   // role, group, reset password
        AddHandler("DELETE /users/{id}",           handler.AdminDeleteUser).
        AddHandler("POST   /groups",               handler.AdminCreateGroup).
        AddHandler("GET    /groups",               handler.AdminListGroups).
        AddHandler("PUT    /groups/{id}",          handler.AdminUpdateGroup).  // priority
        AddHandler("DELETE /groups/{id}",          handler.AdminDeleteGroup).
        AddHandler("GET    /benchmarks",           handler.AdminListBenchmarks).
        AddHandler("DELETE /benchmarks/{id}",      handler.AdminDeleteBenchmark).
        AddHandler("POST   /benchmarks/{id}/cancel", handler.AdminCancelBenchmark)

    router.AddSubroute("/api/v1/", protected.Finalize())
    router.AddSubroute("/api/v1/admin/", admin.Finalize())
    final := router.Finalize()

    // --- Background workers ---
    go worker.NewBenchmarkRunner(cfg, db, rdb).Run(ctx)   // pool of MAX_PARALLELISM goroutines
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

func RequireAdmin(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        c := middleware.ClaimsFromContext(r.Context())
        if c == nil || c.Role != "admin" {
            http.Error(w, "forbidden", http.StatusForbidden)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

### 4.2 JWT

- Algorithm: HS256; secret from Docker secret `jwt_secret`.
- Claims: `{ "sub": <user_id>, "email": <email>, "role": <"admin"|"user">, "group_id": <uuid|null>, "jti": <uuid>, "exp": <unix> }`.
- Expiry: `JWT_EXPIRY` env (default `24h`).
- `jti` is the blocklist key.

### 4.3 API table

#### Public

| Method | Endpoint | Description |
|:--|:--|:--|
| `POST` | `/api/v1/auth/login` | Body `{email, password}` → `{token}`. Rate-limited 5/min/IP. |
| `GET`  | `/api/v1/health` | `{status:"ok"}`. |
| `GET`  | `/api/v1/config` | `{maxFileSizeMb, smtpEnabled}`. Public so the upload form can pre-validate. |

#### Protected (user + admin)

| Method | Endpoint | Description |
|:--|:--|:--|
| `POST` | `/api/v1/auth/logout` | Blocklist the current JWT (`jti`, TTL = remaining lifetime). |
| `PUT`  | `/api/v1/auth/password` | Body `{current_password, new_password}`; update `password_hash`; issue a fresh JWT. |
| `GET`  | `/api/v1/me` | Current user profile + group. |
| `GET`  | `/api/v1/compressors` | Compressor-options registry (§3.3 / §6.2). |
| `GET`  | `/api/v1/benchmarks/checksums` | `[{"checksum":"<md5>"}, ...]` of all `benchmarks.file_checksum` (for client-side duplicate check). |
| `POST` | `/api/v1/benchmarks` | Multipart: `name`, `file`, `compressors` (JSON: `{"<name>": {<option>: <value>}, ...}`). Validates type/size/checksum; inserts `queued` row. |
| `GET`  | `/api/v1/benchmarks` | `?q=<name>&status=<...>&page=<n>&size=<n>` → paginated card data. |
| `GET`  | `/api/v1/benchmarks/{id}` | Full results: all `benchmark_results` rows + selected compressors + metadata. |
| `GET`  | `/api/v1/benchmarks/{id}/status` | `{status, started_at, finished_at, error?}`. |
| `GET`  | `/api/v1/benchmarks/compare` | `?ids=a,b,c,d,e` (≤ 5) → merged results for the compare page. |
| `GET`  | `/api/v1/status` | `{queue_depth, runner:{running, max_parallelism}, stats:{queued, in_progress, ready, failed, timed_out, cancelled}}`. |

#### Admin (role = admin)

| Method | Endpoint | Description |
|:--|:--|:--|
| `POST`   | `/api/v1/admin/users` | Body `{email, password, role, group_id?}`. Create a user. |
| `GET`    | `/api/v1/admin/users` | List users (with role + group). |
| `PUT`    | `/api/v1/admin/users/{id}` | Body `{role?, group_id?, reset_password?}`. |
| `DELETE` | `/api/v1/admin/users/{id}` | Soft-delete a user. |
| `POST`   | `/api/v1/admin/groups` | Body `{name, priority}`. |
| `GET`    | `/api/v1/admin/groups` | List groups. |
| `PUT`    | `/api/v1/admin/groups/{id}` | Body `{name?, priority?}`. |
| `DELETE` | `/api/v1/admin/groups/{id}` | Delete group (users' `group_id` → NULL). |
| `GET`    | `/api/v1/admin/benchmarks` | List all benchmarks across users. |
| `DELETE` | `/api/v1/admin/benchmarks/{id}` | Delete a benchmark + its results. |
| `POST`   | `/api/v1/admin/benchmarks/{id}/cancel` | Set a `queued`/`in_progress` benchmark to `cancelled`. |

### 4.4 Background workers

#### Benchmark Runner (the core worker)
A pool of `MAX_PARALLELISM` goroutines. Each iteration:
1. `SELECT id FROM benchmarks WHERE status='queued' ORDER BY g.priority DESC, b.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1` (join `groups`).
2. `UPDATE benchmarks SET status='in_progress', started_at=NOW() WHERE id=$1 AND status='queued'` (re-guard).
3. Normalize the uploaded file to `.bin`(s) under `DATA_DIR/<id>/`.
4. For each `.bin`, run `timeout $BENCH_TIMEOUT_SECONDS $BENCH_BINARY -c <compressors> -o <out.csv> <file.bin>` (set `LD_LIBRARY_PATH` to the bundled Squash libs when using `LosslessBenchmarkFull`).
5. Parse every `<out.csv>` (§6.3 schema); **average** all rows per compressor into one row.
6. Insert `benchmark_results`.
7. `UPDATE benchmarks SET status='ready', finished_at=NOW() WHERE id=$1`; delete `DATA_DIR/<id>/` and the original upload.
8. On exit code `124` → `status='timed_out'`, `error='timeout after <n>s'`, cleanup files. On other non-zero → retry up to `BENCH_MAX_RETRIES`, then `status='failed'`, `error=<stderr tail>`.

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

Client-side pre-checks (frontend): extension allow-list + size ≤ `MAX_FILE_SIZE_MB` (from `GET /api/v1/config`). Server-side re-checks the same and computes the MD5; rejects if `benchmarks.file_checksum` already exists (global, per D6).

#### Filename-escaping rule (D5, unambiguous)
- Compute `md5 = MD5(file_bytes)` (hex, lowercase, 32 chars).
- `escaped = regex_replace(original_basename_without_ext, r"[^a-zA-Z0-9]", "_")` (collapse runs of non-alphanumerics into a single `_`; strip leading/trailing `_`).
- Stored filename: `{escaped}-{md5}.{ext}`. Example: `ECG gap!.bin` → `ECG_gap-<md5>.bin`.
- For `.zip`/`.tar`: the **archive** is stored as `{escaped}-{md5}.zip`; its inner `.bin` files keep their original names inside `DATA_DIR/<id>/` during normalization.

---

## 5. Database Schema

**File:** `backend/migrations/0001_initial.sql`. Plain PostgreSQL (D7). Uses `uuid-ossp`.

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
-- USERS  (admin-created only; D1)
-- ============================================================
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,           -- bcrypt or argon2id
    role          VARCHAR(10) NOT NULL CHECK (role IN ('admin','user')) DEFAULT 'user',
    group_id      UUID REFERENCES groups(id) ON DELETE SET NULL,
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
    file_size       BIGINT NOT NULL,
    file_checksum   CHAR(32) UNIQUE NOT NULL,       -- MD5 hex; global uniqueness (D6)
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
```

### Migration workflow

Incremental schema changes live in `backend/migrations/` as `NNNN_description.sql`. Apply via:

```bash
./backend/scripts/migrate.sh   # reads DB_HOST/DB_PORT/DB_USER/DB_NAME from env, db_password from /run/secrets/db_password
```

The script tracks applied files in a `_migrations` table and applies each file once. Idempotent.

### Seeding

On first startup the backend idempotently creates the default admin `admin@bitbench.org` / `changeme` (role `admin`) and a default group `default` (priority 0). The password MUST be changed on first login (enforced by a `must_change_password` flag — add a `BOOLEAN DEFAULT TRUE` column on `users` for the admin seed only; user-created accounts set it `FALSE`).

### Notes & constraints

- SMTP is optional: active only when `SMTP_HOST` is set. When off, the Email Dispatcher is a no-op and users cannot reset passwords via mail (admin resets).
- Groups set workload priority (D10).
- Files are ephemeral (D5): deleted after the benchmark finishes.

---

## 6. Compression Integration & Benchmark Runner

### 6.1 The C++ benchmark

Source: `compression/`. Build artifacts: `LosslessBenchmark` (minimal) and `LosslessBenchmarkFull` (with Squash). The Dockerfile builds both at image-build time (D9); the backend prefers `LosslessBenchmarkFull` when present, else `LosslessBenchmark`.

Available compressors (from `-h`): `neats, dac, rle_gef, u_gef_approximate, u_gef_optimal, b_gef_approximate, b_gef_optimal, b_star_gef_approximate, b_star_gef_optimal, gorilla, chimp, chimp128, tsxor, elf, camel, falcon, alp, pfordelta, gzip_1, gzip_6, gzip_9, bzip3` (and `bzip2` in Full mode).

Invocation (the ONLY flags the backend uses):
```
$BENCH_BINARY -c <comma-separated-compressors> -o <out.csv> <file.bin>
```
With `LD_LIBRARY_PATH` pointing at the bundled Squash libraries when running Full. Timeout enforced by the `timeout` wrapper (`BENCH_TIMEOUT_SECONDS`).

### 6.2 Compressor-options registry (D8)

`internal/compressor/registry.go` exports a static `map[string]map[string]Option`. **To populate it the first time, the agent MUST:**

1. Read `compression/benchmark/lossless_benchmark.cpp` and every `compression/benchmark/<Name>/*.hpp` to find each compressor's configurable parameters (block sizes, levels, modes, thresholds).
2. For each parameter, record `type` (`number`/`boolean`/`select`), `min`, `max`, `default`, `step` (for numbers), or `options` (for `select`).
3. Encode the result in `registry.go`. `GET /api/v1/compressors` serializes this map.
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

### 6.4 Compressor families (for chart coloring/shaping, parity with the HTML report)

| Family | Members | Marker |
|:--|:--|:--|
| Block-sorting | bzip2, bzip3 | square |
| Dictionary-based | Brotli, gzip (1/6/9), lz4, Snappy, XZ, zstd | diamond |
| Time Series | ALP1, Camel, Chimp, Chimp128, Elf, Falcon, Gorilla, NeaTS, TSXor | circle |
| GEF | B*-GEF (Approx/Opt), B-GEF (Approx/Opt), RLE-GEF, U-GEF (Approx/Opt) | triangle-up |
| PForDelta | PForDelta | star |
| DAC | DAC | pentagon |

`rename_compressor`: `b_star_gef_approximate`→`B*-GEF (Approx)`, `gzip_6`→`gzip (6)`, etc. (full map in `scripts/generate_full_html_report.py`).

### 6.5 Metric ranking rules (parity with `is_min_best`)

Lower is better: `compression_ratio`, `compressed_bits`, `uncompressed_bits`, `original_size`, `memory_usage`, `compressor_internal`, `internal_memory_ratio`, `relative_memory_usage`, `random_access_ns`, any `*_ns`, any `*_bits`.
Higher is better: everything else (throughputs `*_mbs`, range queries).

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
      - ./angie/nginx.conf:/etc/nginx/nginx.conf:ro
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

  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    develop:
      watch:
        - action: rebuild
          path: ./backend
        - action: rebuild
          path: ./compression
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
      - MAX_PARALLELISM=2
      - MAX_FILE_SIZE_MB=500
      - BENCH_TIMEOUT_SECONDS=3600
      - BENCH_MAX_RETRIES=2
      - DATA_DIR=/data/benchmarks
      - BENCH_BINARY_PATH=/app/bin/LosslessBenchmarkFull
      - SMTP_HOST=${SMTP_HOST:-}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_USER=${SMTP_USER:-}
      - SMTP_FROM=${SMTP_FROM:-}
    volumes:
      - bench_data:/data/benchmarks
    expose:
      - "8080"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
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

> Bug fix: the original compose omitted the `admin-frontend` service and used the TimescaleDB image; both corrected.

### Environment variables (complete reference)

| Variable | Default | Purpose |
|:--|:--|:--|
| `DB_HOST/PORT/USER/NAME` | — | Postgres connection. |
| `REDIS_HOST/PORT` | — | Redis connection. |
| `JWT_EXPIRY` | `24h` | JWT lifetime. |
| `MAX_PARALLELISM` | `2` | Runner goroutine pool size. |
| `MAX_FILE_SIZE_MB` | `500` | Upload size cap (frontend reads via `/config`). |
| `BENCH_TIMEOUT_SECONDS` | `3600` | Per-`.bin` subprocess timeout. |
| `BENCH_MAX_RETRIES` | `2` | Subprocess failure retries. |
| `DATA_DIR` | `/data/benchmarks` | Ephemeral file workspace. |
| `BENCH_BINARY_PATH` | `/app/bin/LosslessBenchmarkFull` | Benchmark executable. |
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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake && rm -rf /var/lib/apt/lists/*
COPY compression/ ./compression/
RUN cd compression && cmake -B build -DCMAKE_BUILD_TYPE=Release -DNEATS_WITH_SQUASH=OFF
RUN cd compression && make -j$(nproc) -C build LosslessBenchmarkFull
RUN mkdir -p /artifacts/bin && cp compression/build/LosslessBenchmarkFull /artifacts/bin/

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
    ca-certificates libstdc++6 libgomp1 libglib2.0-0 libsnappy1v5 libbrotli1 && rm -rf /var/lib/apt/lists/*
COPY --from=cpp-build /usr/local/lib/ /usr/local/lib/
RUN ldconfig
WORKDIR /app
COPY --from=go-build /out/bitbench /app/bitbench
COPY --from=cpp-build /artifacts/bin/ /app/bin/
EXPOSE 8080
CMD ["/app/bitbench"]
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
| Unit | `testing` (stdlib) | CSV result parser (incl. dynamic range columns), MD5 checksum, filename-escaping rule, `.bin` 8-byte vs 16-byte header detection, job-state transition predicates, Pareto-score computation, compressor-option registry serialization |
| Integration | `testing` + `testcontainers-go` | Each handler (happy + error path) against real PostgreSQL + Redis; login → logout + JWT blocklist eviction; upload happy path + duplicate-checksum rejection + oversize rejection; benchmark runner end-to-end (enqueue → run → parse → `ready` → files deleted) |

Minimum per PR: new handler → ≥1 happy + ≥1 error integration test; new worker → unit test for the scheduling/claim predicate + integration test for the DB interaction; new migration → integration test against a fresh schema.

**Frontend (TypeScript)**

| Layer | Tool | What to cover |
|:--|:--|:--|
| Unit | Vitest | File-validation logic (type + size), MD5/duplicate-detection logic, option-form rendering rules (slider vs number input by step count), Pareto-score helper, ranking-direction helper |
| Component | React Testing Library | Upload form (valid/invalid/loading states), status pill states (`queued`/`in_progress`/`ready`), error states, advanced-options accordion |
| E2E | Playwright | Login, upload a benchmark, view detail charts, compare two benchmarks |

Minimum per PR: new UI component → component tests for its interactive states; new pure logic → unit tests with known input/output vectors; new user journey → happy-path Playwright test.

> Bug fix: the original spec copied Budgeteer's "crypto pipeline / LWW conflict resolver / offline queue / add transaction / joint account invite" test targets and the `NewEmailDispatcher`/`NewJobCron` example workers. BitBench has **no E2E crypto, no LWW, no offline queue, no transactions, no joint accounts** — all replaced with the BitBench targets above.

### 8.4 CI pipeline

`.github/workflows/ci.yml` runs on every push and on PRs targeting `master`:

```
1. Lint       — golangci-lint (Go), ESLint + tsc --noEmit (TS)
2. Unit tests — go test ./... (Go), vitest run (TS)
3. Integration — testcontainers suite against postgres + redis
4. E2E        — Playwright against a docker-compose stack
5. Build      — go build (Go), vite build (TS, both frontend + admin-frontend)
```

All five gates must be green. A red pipeline blocks merge regardless of approvals.

---

## 9. Design Context

**Register:** product (app UI, dashboard, data analysis tool)
**North Star:** The Lab Bench — a precision instrument, not a decorative dashboard.
**Brand:** Precise · Technical · Confident. No-nonsense research tool.
**Anti-references:** No SaaS dashboard clichés (hero metrics, gradient cards), no consumer playfulness, no enterprise gray-on-gray.

For the full design system with color tokens, typography, component specs, and Named Rules see `PRODUCT.md` and `DESIGN.md` at the project root.
