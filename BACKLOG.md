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

- [x] Compressor naming: use properly capitalized display names (gzip→Gzip, dac→DAC, etc.) from `compression/scripts/generate_full_html_report.py`.
- [x] Scatter plots: use family-based colors and shapes from generate_full_html_report.py (per-compressor colors, diamond/square/triangle markers per family).
- [x] Bar charts: per-compressor colors from the same reference.

## Results

- [x] Fixed as above in General bugs (compressor naming & scatter colors/shapes).

## Upload

- [x] Added accepted file format info text below the upload area.
- [x] Removed the single hash UNIQUE constraint. Checksums are now indexed (non-unique) for grouping in comparison page.
- [x] Multi-file selection: added support for dragging/selecting multiple files. Options: "Average results" (uploads first file) or "Run separate benchmarks" (enqueues each file sequentially).
- [x] xz, zstd, lz4, brotli, bzip2 now have level options in the registry (zstd:1-22, lz4:1-12, brotli:0-11, xz:0-9, bzip2:1-9).
- [x] Added `last_bench_config` JSONB column to users table. Saved on submit, restored on page load via GET /me.
- [x] Autocomplete benchmark name with the first filename (without extension).

## Admin

- [x] Paginated benchmark table (cursor-based) with "Load more" button.
- [x] Multiselect checkboxes + batch delete button.

## Remaining (future)

- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)
- [ ] Add `--cap-add=SYS_PTRACE` or `seccomp=unconfined` to docker-compose for Valgrind
- [ ] `relative_memory_usage` and `internal_memory_ratio` columns (schema done, no chart yet)
