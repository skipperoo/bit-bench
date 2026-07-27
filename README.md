# BitBench -- Compression Algorithm Benchmarking Platform

BitBench is a **web-based platform** for evaluating lossless compression algorithms on integer sequence data. Researchers upload their datasets, select compressors with tunable parameters, and receive ranked results with Pareto-optimal trade-off analysis.

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

Then open **<http://localhost>** (main frontend) or **<http://localhost:81>** (admin panel).

Default admin credentials: `admin@bitbench.org` / `changeme` (can be changed from the admin panel).

> **Prerequisites:** Docker, Docker Compose and an AVX/AVX2 compatible processor.

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
- [Project Structure](#project-structure)

---

## What is BitBench?

BitBench helps researchers answer the question: _"Which lossless compressor performs best on my data?"_

1. **Upload** a file containing integer sequences (`.bin`, `.csv`, `.zip`, or `.tar`).
2. **Select** compressors and tune their parameters (e.g., compression level, block size, mode).
3. **Wait** while the benchmark binary runs each compressor against your data.
4. **Analyse** the results: ranked tables, grouped bar charts, Pareto scatter plots, and a composite Top-5 summary.

Metrics measured for every compressor:

| Metric                   | Description                                                         | Direction        |
| :----------------------- | :------------------------------------------------------------------ | :--------------- |
| Compression ratio        | Compressed bits ÷ uncompressed bits (×100 → %)                      | Lower is better  |
| Compression throughput   | MB/s during compression                                             | Higher is better |
| Decompression throughput | MB/s during full decompression                                      | Higher is better |
| Memory usage             | Peak memory footprint including the input buffer (MB)               | Lower is better  |
| Compressor memory usage  | Peak memory footprint considering only the compression routine (MB) | Lower is better  |
| Random access            | ns per random access query                                          | Lower is better  |
| Range queries            | MB/s for range scans (at multiple ranges)                           | Higher is better |

The **Top-5 summary** computes a Pareto domination score balancing compression ratio and throughput, flagging Pareto-optimal compressors with a badge.

---

## Acknowledgments

The Generalized Elias Fano (GEF) compressors family:

> **[mxpucci/generalized-elias-fano](https://github.com/mxpucci/generalized-elias-fano)**
> A C++ library providing the GEF, B-GEF, B\*-GEF, U-GEF, and RLE-GEF compressors.

The benchmark binary, compressor implementations, dataset preparation scripts, and result analysis tools originate from:

> **[mxpucci/gef-experiments](https://github.com/mxpucci/gef-experiments)**
> A comprehensive benchmarking framework for lossless compression of integer sequences, including the `LosslessBenchmark` and `LosslessBenchmarkFull` binaries that BitBench uses as its execution engine.

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

- **Admin-created accounts only**: admin creates users from the admin panel.
- **PostgreSQL as job queue**: the `benchmarks` table doubles as the work queue (`FOR UPDATE SKIP LOCKED`). No separate job broker.
- **Ephemeral files**: uploaded files are deleted once the benchmark finishes. Re-running requires re-upload.
- **Multi-stage Docker build**: the C++ benchmark binary and Squash libraries are compiled at image-build time, producing a slim runtime image.

### Services

| Service            | Port          | Description                                                                  |
| :----------------- | :------------ | :--------------------------------------------------------------------------- |
| **nginx**          | 80 / 81       | Reverse proxy: `/*` → frontend, `/api/*` → backend, port 81 → admin frontend |
| **frontend**       | 80 (internal) | Vite/React main app -- upload, results, compare pages                        |
| **admin-frontend** | 80 (internal) | Vite/React admin panel -- user & group CRUD, benchmark management            |
| **backend**        | 8080          | Go HTTP server + background benchmark runner                                 |
| **postgres**       | 5432          | Database (users, groups, benchmarks, results)                                |
| **redis**          | 6379          | JWT blocklist + rate limiting (ephemeral, no volume)                         |

---

## Supported Compressors

BitBench supports the following compressors, grouped by family (used for chart colouring and marker shapes):

| Family               | Compressors                                                           |
| :------------------- | :-------------------------------------------------------------------- |
| **Block-sorting**    | bzip2, bzip3                                                          |
| **Dictionary-based** | Brotli, gzip, lz4, Snappy, XZ, zstd                                   |
| **Time Series**      | ALP, Camel, Chimp, Chimp128, Elf, Falcon, Gorilla, NeaTS, TSXor       |
| **GEF**              | B\*-GEF (Approx/Opt), B-GEF (Approx/Opt), RLE-GEF, U-GEF (Approx/Opt) |
| **PForDelta**        | PForDelta                                                             |
| **DAC**              | DAC                                                                   |

> Compressors that require the Squash library (Brotli, lz4, Snappy, XZ, zstd, bzip2, bzip3) are only available when using `LosslessBenchmarkFull`. The Docker image builds with Squash by default.

### Tuning Parameters

Each compressor exposes its tunable parameters (inferred from the C++ source). Example:

```json
{
  "gzip": {
    "level": { "type": "number", "min": 1, "max": 9, "default": 6, "step": 1 }
  },
  "falcon": {
    "mode": {
      "type": "select",
      "options": ["fast", "optimal"],
      "default": "fast"
    }
  }
}
```

The frontend renders the appropriate widget (slider, number input, switch, or dropdown) based on the option schema.

---

## Dataset Format & Preparation

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

Uploading multiple files is allowed and the results can be kept separate or averaged together.

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

---

## Building & Running

### Production Build (Recommended)

```bash
# Build images and start all services
docker compose up --build -d

# Follow logs
docker compose logs -f

# Stop everything
docker compose down
```

### Development Mode

For active development with hot-reload:

```bash
docker compose watch
```

This watches `./frontend`, `./admin-frontend`, `./backend`, and `./compression` for changes and rebuilds the affected services automatically.

---

## Configuration

### Environment Variables

| Variable                | Default                          | Description                                         |
| :---------------------- | :------------------------------- | :-------------------------------------------------- |
| `DB_HOST`               | `postgres`                       | Postgres hostname                                   |
| `DB_PORT`               | `5432`                           | Postgres port                                       |
| `DB_USER`               | `bitbench`                       | Postgres user                                       |
| `DB_NAME`               | `bitbench`                       | Postgres database                                   |
| `REDIS_HOST`            | `redis`                          | Redis hostname                                      |
| `REDIS_PORT`            | `6379`                           | Redis port                                          |
| `JWT_EXPIRY`            | `24h`                            | JWT token lifetime                                  |
| `MAX_PARALLELISM`       | `8`                              | Number of concurrent benchmark runner goroutines    |
| `MAX_FILE_SIZE_MB`      | `500`                            | Maximum upload file size (MB)                       |
| `BENCH_TIMEOUT_SECONDS` | `3600`                           | Per-benchmark subprocess timeout                    |
| `BENCH_MAX_RETRIES`     | `2`                              | Number of retries on non-zero exit                  |
| `DATA_DIR`              | `/data/benchmarks`               | Ephemeral workspace for uploaded files              |
| `BENCH_BINARY_PATH`     | `/app/bin/LosslessBenchmarkFull` | Path to the benchmark binary                        |
| `SMTP_HOST`             | _(empty)_                        | SMTP server hostname (leave empty to disable email) |
| `SMTP_PORT`             | `587`                            | SMTP port                                           |
| `SMTP_USER`             | _(empty)_                        | SMTP username                                       |
| `SMTP_FROM`             | _(empty)_                        | SMTP from address                                   |

### Secrets (mounted at `/run/secrets/`)

| Secret               | Required | Contents                                           |
| :------------------- | :------- | :------------------------------------------------- |
| `jwt_secret.txt`     | Yes      | HMAC-SHA256 key for JWT signing                    |
| `db_password.txt`    | Yes      | PostgreSQL password                                |
| `redis_password.txt` | Yes      | Redis password                                     |
| `smtp_password.txt`  | No       | SMTP password (can be empty when SMTP is disabled) |

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
