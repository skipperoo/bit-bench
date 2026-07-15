# BitBench -- Compression Algorithm Benchmarking Platform

BitBench is a **web-based platform** for evaluating lossless compression algorithms on integer sequence data. Researchers upload their datasets, select compressors with tunable parameters, and receive ranked results with Pareto-optimal trade-off analysis -- all through a clean, precise web interface.

Born from the [GEF Experiments](https://github.com/mxpucci/gef-experiments) benchmarking suite, BitBench wraps the same C++ benchmark binary (`LosslessBenchmark`) in a full-stack web application: a Go backend with PostgreSQL, Redis, and a React frontend that renders the ranked tables, bar charts, and Pareto scatter plots that compression researchers rely on.

## Quick Start

```bash
# Generate required secrets
echo -n "super-secret-jwt-key-here" > secrets/jwt_secret.txt
echo -n "bitbench_db_pass"          > secrets/db_password.txt
echo -n "bitbench_redis_pass"       > secrets/redis_password.txt
echo -n ""                          > secrets/smtp_password.txt

# Build and start everything
docker compose up --build
```

Then open **http://localhost** (main frontend) or **http://localhost:81** (admin panel).

Default admin credentials: `admin@bitbench.org` / `changeme` (must change on first login).

> **Prerequisites:** Docker and Docker Compose v2. No local Go, C++, or Node toolchain required -- everything is containerised.

---

## Table of Contents

- [What is BitBench?](#what-is-bitbench)
- [Acknowledgments](#acknowledgments)
- [Architecture Overview](#architecture-overview)
- [Supported Compressors](#supported-compressors)
- [Dataset Format & Preparation](#dataset-format--preparation)
- [Building & Running](#building--running)
  - [Development Mode](#development-mode)
  - [Production Build](#production-build)
- [Configuration](#configuration)
- [API Overview](#api-overview)
- [Project Structure](#project-structure)
- [License](#license)

---

## What is BitBench?

BitBench helps researchers answer a concrete question: *"Which lossless compressor performs best on my data?"*

The workflow is straightforward:

1. **Upload** a file containing integer sequences (`.bin`, `.csv`, `.zip`, or `.tar`).
2. **Select** compressors and tune their parameters (e.g., compression level, block size, mode).
3. **Wait** while the benchmark binary runs each compressor against your data.
4. **Analyse** the results: ranked tables, grouped bar charts, Pareto scatter plots, and a composite Top-5 summary.

Metrics measured for every compressor:

| Metric | Description | Direction |
|:--|:--|:--|
| Compression ratio | Compressed bits ÷ uncompressed bits (×100 → %) | Lower is better |
| Compression throughput | MB/s during compression | Higher is better |
| Decompression throughput | MB/s during full decompression | Higher is better |
| Memory usage | Peak memory footprint (MB) | Lower is better |
| Random access | ns per random access query | Lower is better |
| Range queries | MB/s for range scans (at multiple ranges) | Higher is better |

The **Top-5 summary** computes a Pareto domination score balancing compression ratio and throughput, flagging Pareto-optimal compressors with a badge.

---

## Acknowledgments

BitBench builds directly on prior work by **Maxime Pucci** and contributors.

### Core GEF Implementation

The Generalized Elias Fano (GEF) data structure is implemented at:

> **[mxpucci/generalized-elias-fano](https://github.com/mxpucci/generalized-elias-fano)**  
> A C++ library providing the GEF, B-GEF, B*-GEF, U-GEF, and RLE-GEF compressors.

### Benchmarking Suite

The benchmark binary, compressor implementations, dataset preparation scripts, and result analysis tools originate from:

> **[mxpucci/gef-experiments](https://github.com/mxpucci/gef-experiments)**  
> A comprehensive benchmarking framework for lossless compression of integer sequences, including the `LosslessBenchmark` and `LosslessBenchmarkFull` binaries that BitBench uses as its execution engine.

### Original Benchmark Framework

The benchmark infrastructure is derived from the **[NeaTS](https://github.com/and-gue/NeaTS)** project (by André Guerreiro), which provided the initial benchmarking harness and several compressor implementations.

### Dataset Sources

See [`compression/README.md`](compression/README.md) for full attribution of the reference datasets (NEON, INFORE Project, Microsoft Research GeoLife, Meteoblue, InfluxData, and others).

---

## Architecture Overview

```
┌────────────┐    ┌─────────────┐    ┌──────────────────┐
│ Frontend   │──▶ │ Backend     │──▶ │ PostgreSQL        │
│ (Vite/React)│   │ (Go + routy)│    │  users, groups,   │
└────────────┘    │             │    │  benchmarks,      │
┌────────────┐    │  - handlers │    │  results          │
│ Admin FE   │──▶ │  - runner   │    └──────────────────┘
│ (separate) │    │    pool (N) │──▶ ┌──────────────────┐
└────────────┘    │  - C++ bin  │    │ Redis             │
                  │    subprocess│   │ (JWT blocklist    │
                  └──────┬──────┘    │  + rate limiting) │
                         │ spawns    └──────────────────┘
                         ▼
                  ┌──────────────────┐
                  │ LosslessBenchmark│ (C++ binary)
                  │ -c <compressors> │
                  │ -o <out.csv>     │
                  └──────────────────┘
```

### Key Design Decisions

- **Admin-created accounts only** -- no self-registration. Admin creates users from the admin panel.
- **PostgreSQL as job queue** -- the `benchmarks` table doubles as the work queue (`FOR UPDATE SKIP LOCKED`). No separate job broker.
- **Ephemeral files** -- uploaded files are deleted once the benchmark finishes. Re-running requires re-upload.
- **Global checksum deduplication** -- a file with the same MD5 cannot be uploaded twice, even by different users.
- **Multi-stage Docker build** -- the C++ benchmark binary and Squash libraries are compiled at image-build time, producing a slim runtime image.

### Services

| Service | Port | Description |
|:--|:--|:--|
| **nginx** | 80 / 81 | Reverse proxy: `/*` → frontend, `/api/*` → backend, port 81 → admin frontend |
| **frontend** | 80 (internal) | Vite/React main app -- upload, results, compare pages |
| **admin-frontend** | 80 (internal) | Vite/React admin panel -- user & group CRUD, benchmark management |
| **backend** | 8080 | Go HTTP server + background benchmark runner |
| **postgres** | 5432 | Database (users, groups, benchmarks, results) |
| **redis** | 6379 | JWT blocklist + rate limiting (ephemeral, no volume) |

---

## Supported Compressors

BitBench supports the following compressors, grouped by family (used for chart colouring and marker shapes):

| Family | Compressors |
|:--|:--|
| **Block-sorting** | bzip2, bzip3 |
| **Dictionary-based** | Brotli, gzip, lz4, Snappy, XZ, zstd |
| **Time Series** | ALP, Camel, Chimp, Chimp128, Elf, Falcon, Gorilla, NeaTS, TSXor |
| **GEF** | B*-GEF (Approx/Opt), B-GEF (Approx/Opt), RLE-GEF, U-GEF (Approx/Opt) |
| **PForDelta** | PForDelta |
| **DAC** | DAC |

> Compressors that require the Squash library (Brotli, lz4, Snappy, XZ, zstd, bzip2, bzip3) are only available when using `LosslessBenchmarkFull`. The Docker image builds with Squash by default.

### Tuning Parameters

Each compressor exposes its tunable parameters (inferred from the C++ source). Example:

```json
{
  "gzip": {
    "level": { "type": "number", "min": 1, "max": 9, "default": 6, "step": 1 }
  },
  "falcon": {
    "mode": { "type": "select", "options": ["fast", "optimal"], "default": "fast" }
  }
}
```

The frontend renders the appropriate widget (slider, number input, switch, or dropdown) based on the option schema.

---

## Dataset Format & Preparation

### Accepted Input Formats

BitBench accepts four file types. After upload, the backend normalises everything to `.bin` before invoking the benchmark binary.

#### 1. Binary (`.bin`) -- direct input

Two header formats (auto-detected by file size):

- **Standard (16-byte header):**
  ```
  [uint64 N] [uint64 decimals] [N × int64 values]
  ```
  File size = `16 + 8N`

- **Simple (8-byte header):**
  ```
  [uint64 N] [N × int64 values]
  ```
  File size = `8 + 8N`

Validation: both formats are tried; the file is accepted if either yields an exact integer `N ≥ 0`.

#### 2. CSV (`.csv`) -- multi-column

Each column is treated as a separate integer sequence. The backend materialises one `.bin` per column (16-byte header, `decimals=0`) and runs all compressors on each. Results are **averaged** across columns into one row per compressor.

The CSV must have a header row; every column is parsed as a sequence of integer values.

#### 3. Zip / Tar (`.zip`, `.tar`) -- batch

Containing one or more `.bin` files. Each inner `.bin` is extracted and benchmarked individually; results are **averaged** across all inner files into one row per compressor.

### How to Prepare Your Own Dataset

The benchmark evaluates compressors on sequences of **64-bit signed integers**. To create a valid `.bin` file from your data:

**Python (simple format):**
```python
import struct

values = [42, -17, 1000000, ...]  # your int64 sequence
with open("my_data.bin", "wb") as f:
    f.write(struct.pack("<Q", len(values)))       # N (uint64 LE)
    for v in values:
        f.write(struct.pack("<q", v))             # each value (int64 LE)
```

**Python (standard format with decimals):**
```python
import struct

values = [42, -17, 1000000, ...]  # your int64 sequence
decimals = 0                       # decimal places (for float-derived ints)
with open("my_data.bin", "wb") as f:
    f.write(struct.pack("<QQ", len(values), decimals))  # N + decimals
    for v in values:
        f.write(struct.pack("<q", v))                    # each value
```

**C++:**
```cpp
#include <cstdint>
#include <fstream>
#include <vector>

int main() {
    std::vector<int64_t> data = {42, -17, 1000000, /* ... */};
    std::ofstream out("my_data.bin", std::ios::binary);
    uint64_t n = data.size();
    out.write(reinterpret_cast<const char*>(&n), sizeof(n));  // simple format
    out.write(reinterpret_cast<const char*>(data.data()), n * sizeof(int64_t));
}
```

**From a CSV column:**
```python
import struct, csv

with open("input.csv") as f:
    values = [int(row[0]) for row in csv.reader(f)]

with open("column.bin", "wb") as f:
    f.write(struct.pack("<Q", len(values)))
    for v in values:
        f.write(struct.pack("<q", v))
```

### Guidelines for Meaningful Benchmarks

1. **Use realistic data.** The compressors' relative performance depends heavily on data distribution, entropy, and value range. Real-world data yields actionable results.
2. **Size matters.** Sequences with **at least 100K–1M values** produce stable throughput measurements. Tiny datasets (< 1000 values) are dominated by setup overhead.
3. **Compare within families.** Use the compare page (max 5 benchmarks) to compare results across different datasets or parameter configurations side by side.
4. **Run multiple times.** While BitBench runs once per upload (and deduplicates by checksum), you can vary compressor parameters to explore the tuning landscape.

---

## Building & Running

### Prerequisites

- Docker and Docker Compose v2
- At least 4 GB of RAM (for the C++ build stage)
- The secrets directory must contain four files (see [Quick Start](#quick-start))

### Production Build (Recommended)

```bash
# Build images and start all services
docker compose up --build -d

# Follow logs
docker compose logs -f

# Stop everything
docker compose down
```

The first build compiles:
1. Squash v0.7.0 (compression library)
2. All C++ compressor implementations and the `LosslessBenchmarkFull` binary
3. The Go backend
4. Both Vite/React frontends

This takes **5–15 minutes** depending on your machine. Subsequent rebuilds are incremental.

### Development Mode

For active development with hot-reload:

```bash
docker compose watch
```

This watches `./frontend`, `./admin-frontend`, `./backend`, and `./compression` for changes and rebuilds the affected services automatically.

Without Docker, you can run components individually:

```bash
# Backend
cd backend && go run ./cmd/bitbench-backend

# Frontend
cd frontend && npm run dev

# Admin frontend
cd admin-frontend && npm run dev
```

The backend expects PostgreSQL and Redis to be available -- use `docker compose up postgres redis` for those.

### First-Time Setup

The backend automatically:

1. Applies database migrations (`backend/migrations/`)
2. Seeds a default **admin** user (`admin@bitbench.org` / `changeme`) with a `must_change_password` flag
3. Seeds a default **group** (`default`, priority 0)

Log in, change the admin password, then create user accounts for your team.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|:--|:--|:--|
| `DB_HOST` | `postgres` | Postgres hostname |
| `DB_PORT` | `5432` | Postgres port |
| `DB_USER` | `bitbench` | Postgres user |
| `DB_NAME` | `bitbench` | Postgres database |
| `REDIS_HOST` | `redis` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `JWT_EXPIRY` | `24h` | JWT token lifetime |
| `MAX_PARALLELISM` | `8` | Number of concurrent benchmark runner goroutines |
| `MAX_FILE_SIZE_MB` | `500` | Maximum upload file size (MB) |
| `BENCH_TIMEOUT_SECONDS` | `3600` | Per-benchmark subprocess timeout |
| `BENCH_MAX_RETRIES` | `2` | Number of retries on non-zero exit |
| `DATA_DIR` | `/data/benchmarks` | Ephemeral workspace for uploaded files |
| `BENCH_BINARY_PATH` | `/app/bin/LosslessBenchmarkFull` | Path to the benchmark binary |
| `SMTP_HOST` | *(empty)* | SMTP server hostname (leave empty to disable email) |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | *(empty)* | SMTP username |
| `SMTP_FROM` | *(empty)* | SMTP from address |

### Secrets (mounted at `/run/secrets/`)

| Secret | Required | Contents |
|:--|:--|:--|
| `jwt_secret.txt` | Yes | HMAC-SHA256 key for JWT signing |
| `db_password.txt` | Yes | PostgreSQL password |
| `redis_password.txt` | Yes | Redis password |
| `smtp_password.txt` | No | SMTP password (can be empty when SMTP is disabled) |

---

## API Overview

### Public Endpoints

| Method | Path | Description |
|:--|:--|:--|
| `POST` | `/api/v1/auth/login` | Authenticate -- returns JWT |
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/api/v1/config` | Public config (`maxFileSizeMb`, `smtpEnabled`) |

### Protected Endpoints (JWT required)

| Method | Path | Description |
|:--|:--|:--|
| `POST` | `/api/v1/auth/logout` | Revoke current JWT |
| `PUT` | `/api/v1/auth/password` | Change password |
| `GET` | `/api/v1/me` | Current user profile |
| `GET` | `/api/v1/compressors` | Available compressors and their options |
| `GET` | `/api/v1/benchmarks/checksums` | All file checksums (for duplicate detection) |
| `POST` | `/api/v1/benchmarks` | Upload and start a benchmark |
| `GET` | `/api/v1/benchmarks` | List benchmarks (paginated, filterable) |
| `GET` | `/api/v1/benchmarks/{id}` | Benchmark detail with results |
| `GET` | `/api/v1/benchmarks/{id}/status` | Current status |
| `GET` | `/api/v1/benchmarks/compare` | Compare up to 5 benchmarks |
| `GET` | `/api/v1/status` | Queue depth and runner statistics |

### Admin Endpoints (`role=admin` required)

| Method | Path | Description |
|:--|:--|:--|
| `POST` | `/api/v1/admin/users` | Create user |
| `GET` | `/api/v1/admin/users` | List users |
| `PUT` | `/api/v1/admin/users/{id}` | Update user (role, group, password reset) |
| `DELETE` | `/api/v1/admin/users/{id}` | Soft-delete user |
| `POST` | `/api/v1/admin/groups` | Create group |
| `GET` | `/api/v1/admin/groups` | List groups |
| `PUT` | `/api/v1/admin/groups/{id}` | Update group (priority) |
| `DELETE` | `/api/v1/admin/groups/{id}` | Delete group |
| `GET` | `/api/v1/admin/benchmarks` | List all benchmarks |
| `DELETE` | `/api/v1/admin/benchmarks/{id}` | Delete benchmark and results |
| `POST` | `/api/v1/admin/benchmarks/{id}/cancel` | Cancel a queued/running benchmark |

---

## Project Structure

```
.
├── admin-frontend/          # React admin panel (Vite + Tailwind + Shadcn)
│   ├── Dockerfile
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── lib/
│   └── package.json
│
├── backend/                 # Go backend
│   ├── cmd/
│   │   └── bitbench-backend/
│   │       └── main.go      # Entry point
│   ├── internal/
│   │   ├── config/          # Environment + secret loading
│   │   ├── compressor/      # Compressor registry (static Go map)
│   │   ├── handler/         # HTTP handlers
│   │   ├── logger/          # Structured logging
│   │   ├── middleware/      # JWT auth, admin guard, rate limiting
│   │   ├── model/           # Domain types
│   │   ├── repository/      # Database queries
│   │   ├── service/         # Business logic
│   │   └── worker/          # Benchmark runner + email dispatcher
│   ├── migrations/          # SQL migration files
│   ├── scripts/             # Migration helper scripts
│   ├── Dockerfile           # Multi-stage: Squash → C++ → Go → runtime
│   ├── go.mod / go.sum
│   └── Makefile
│
├── compression/             # C++ benchmark suite (git submodule)
│   ├── benchmark/
│   │   ├── lossless_benchmark.cpp  # Main benchmark binary
│   │   ├── Chimp/                  # Chimp / Chimp128 compressors
│   │   ├── Gorilla/                # Gorilla compressor
│   │   ├── Elf/                    # Elf compressor
│   │   ├── Camel/                  # Camel compressor
│   │   ├── TSXor/                  # TSXor compressor
│   │   └── ...
│   ├── lib/                  # Third-party libraries (GEF, etc.)
│   ├── NeaTS/                # Benchmarking framework headers
│   └── README.md             # Original documentation
│
├── frontend/                # React main app (Vite + Tailwind + Shadcn)
│   ├── Dockerfile
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── lib/
│   └── package.json
│
├── nginx/
│   └── nginx.conf           # Reverse proxy config
│
├── scripts/                 # Python analysis scripts
│   ├── final_results.py            # Generate final_results.html report
│   ├── pareto_plots.py             # Pareto scatter plots
│   ├── compact_tables.py           # Compact LaTeX tables
│   ├── full_tables.py              # Full LaTeX tables
│   ├── table_html_index.py         # HTML table index
│   ├── merge_results.py            # Merge multiple CSV results
│   ├── dataset_stats.py            # Dataset statistics
│   └── measure_memory_massif.py    # Valgrind massif memory profiling
│
├── secrets/                 # Secret files (gitignored)
│   ├── jwt_secret.txt
│   ├── db_password.txt
│   ├── redis_password.txt
│   └── smtp_password.txt
│
├── docker-compose.yml       # Service definitions
├── AGENTS.md                # Full technical specification
├── PRODUCT.md               # Product vision & brand guidelines
├── DESIGN.md                # Design system (colours, typography, tokens)
└── BACKLOG.md               # Development backlog
```

---

## Development

### Branching Strategy

- `master` -- stable, deployable
- `develop` -- integration branch
- `feature/*` -- new functionality
- `fix/*` -- bug fixes
- `refactor/*` -- internal restructuring
- `migration/*` -- database schema changes
- `chore/*` -- tooling, dependencies, CI

### Testing Requirements

| Layer | Tool | What to cover |
|:--|:--|:--|
| Backend unit | Go `testing` | CSV parser, checksum logic, filename escaping, binary header detection, Pareto score, state transitions |
| Backend integration | `testcontainers-go` | Each handler against real PostgreSQL + Redis; upload → run → parse → ready |
| Frontend unit | Vitest | File validation, option-form rendering rules, Pareto helper, ranking direction |
| Frontend component | React Testing Library | Upload form states, status pills, error states, accordion |
| E2E | Playwright | Login → upload → view results → compare |

---

## Performance Scripts

The repository includes Python scripts for offline analysis (not web-integrated):

```bash
# Generate the full HTML report from a benchmark CSV
python scripts/final_results.py benchmark_results/results.csv --output report.html

# Generate Pareto plots
python scripts/pareto_plots.py benchmark_results/results.csv --output plots/

# Generate LaTeX tables
python scripts/compact_tables.py benchmark_results/results.csv --output tables/

# Merge multiple CSV result files
python scripts/merge_results.py benchmark_results/*.csv --output merged.csv

# Compute dataset statistics
python scripts/dataset_stats.py datasets/*.bin
```

These scripts are the same ones used in the original GEF Experiments suite and produce the same visual output format that the web frontend reproduces.

---

## License

Refer to the individual component licenses:

- The **C++ benchmark suite** and compressor implementations derive from [NeaTS](https://github.com/and-gue/NeaTS) and [gef-experiments](https://github.com/mxpucci/gef-experiments).
- The **GEF library** is at [generalized-elias-fano](https://github.com/mxpucci/generalized-elias-fano).
- The **Go backend** and **frontends** are original work under this repository.

See the `compression/` submodule and its vendored dependencies for full license terms.
