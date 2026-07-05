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

## Compression benchmark

- [x] Merge gzip_* into one gzip benchmark with `=LEVEL` syntax via `-c`.
- [x] Use `=LEVEL` syntax to set the level of all dictionary based compressors.
- [x] Add tunable level (1-9, maps to block_size) to bzip3.
- [x] Update backend registry: gzip has `level` option, bzip3 has `level` option.
- [x] Implemented on both lossless_benchmark.cpp AND memory_harness.cpp.
- [x] fix_report.md created at `compression/fix_report.md`.
