# BitBench — Backlog

- [x] done
- [ ] open

# Todo

## Memory Benchmarking

- [x] Port the `compression/scripts/measure_memory_massif.py` script logic to Go backend (`internal/worker/memory_runner.go`).
- [x] Build `memory_harness.cpp` (`MemoryHarness`) in Docker image alongside `LosslessBenchmarkFull`.
- [x] Add Valgrind and `time` to the runtime Docker image for Massif-based memory measurement.
- [x] Run MemoryHarness under Valgrind Massif for each compressor after the main benchmark completes.
- [x] Add DB migration `0002_memory_columns.sql` for `input_buffer`, `compressor_internal`, `internal_memory_ratio`, `relative_memory_usage`.
- [x] Update `BenchmarkResult` model and repository with new memory columns.
- [x] Wire memory metrics into frontend detail page (memory_usage, compressor_internal, relative_memory_usage, internal_memory_ratio bar charts).

## Remaining (future)

- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)
- [ ] Add `--cap-add=SYS_PTRACE` or `seccomp=unconfined` to docker-compose for Valgrind

# Bugs

## Results

- [x] Scatter plots: sorted by compression ratio ascending (x-axis).
- [x] Y-axis label offset increased from 35 to 45 for all bar and scatter charts.
- [x] Removed `relative_memory_usage`, `internal_memory_ratio` metric sections and labels.
- [x] Renamed `compressor_internal` to "Compressor Memory (MB)". Now shows "Memory Usage (MB)" (total peak) and "Compressor Memory (MB)" (peak − baseline).

## Status

- [x] Wire runner.Running() atomic counter into GET /api/v1/status so the StatusPage shows actual running workers.
- [x] Add `progress` column to benchmarks table (INTEGER, 0–100).
- [x] Benchmark runner updates progress: 50% after perf benchmark, incremental 50→100% during memory harness runs.
- [x] GET /api/v1/benchmarks/{id}/status returns `progress` field.
- [x] Frontend ResultsPage shows progress bar + percentage for `in_progress` benchmarks.

## Upload

- [ ] Add a biref information on which file formats are accepted and the structure they must have.
- [ ] Remove the single hash constraint. Keep the hashing to later reference benchmarks over the same file and group them in the comparison page, but let the use run multiple benchmarks on the same file.
- [ ] Allow the user to select multiple files and add the option to ask the user to average the results (behave like a tar/zip upload) or to run multiple benchmarks (enqueue the files). Try to implement this change without changing the backend, handling it on the frontend.
- [ ] xz, zstd, lz4, brotli and bzip2 are missing level options. Please understand what levels they offer and add them to the registry.
- [ ] Add a jsonb column to the user database where the backend saves the last benchmark config, so that the backend can send it to the frontend and automatically re-apply it. The config is updated whenever the user makes a selection changes (both compressor and compressor config).
- [ ] Autocomplete the benchmark name with the filename, otherwise in case of multiple file let the user select a name and the enqueued benchmark will be named NAME_ENTERED (filename) automatically. Show the info about this when the user selects multiple files + non-average (sequential benchmarks).

## Admin

- [ ] Paginate the benchmark table
- [ ] Allow multiselect on the benchmark table to delete multiple entries
