# BitBench — Backlog

- [x] done
- [ ] open

# Todo

## Memory Benchmarking

- [ ] Port the `compression/scripts/measure_memory_massif.py` script to Go backend.
- [ ] Copy and compile also the `compression/benchmark/memory_harness.cpp` executable to test also the memory footprint of the compressors.
- [ ] Add memory usage plots (only total and compressor specific) to the results. Reference `compression/scripts/generate_full_html_report.py` and `compression/scripts/{merge_results,final_results}.py` to have an idea on how the results are processed.

## Remaining (future)

- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)

# Bugs

## Compression benchmark

- [x] Merge gzip_* into one gzip benchmark with `=LEVEL` syntax via `-c`.
- [x] Use `=LEVEL` syntax to set the level of all dictionary based compressors.
- [x] Add tunable level (1-9, maps to block_size) to bzip3.
- [x] Update backend registry: gzip has `level` option, bzip3 has `level` option.
- [x] Implemented on both lossless_benchmark.cpp AND memory_harness.cpp.
- [x] fix_report.md created at `compression/fix_report.md`.
