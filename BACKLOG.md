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

## UI/UX fixes

- [ ] Fix histogram plots:
  - [ ] Must be +50% taller
  - [ ] The left label is is hidden and goes behind the y-ticks and is cut
- [ ] Fix scatter plots:
  - [ ] The legend overwrites the x label, move it a bit down
  - [ ] Must be +150% taller
- [ ] When hovering over the points, the results are correct but they all share the same x coordinate so all the points are vertically aligned over the same x coordinate, thus they are also reported to be pareto optimal. Plot the points properly.
