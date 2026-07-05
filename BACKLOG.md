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

- [x] Fix histogram plots:
  - [x] Must be +50% taller (OverviewBarChart: h-72→h-[432px], MetricBarChart: h-64→h-[384px])
  - [x] The left label was hidden behind y-ticks (changed YAxis label position from 'insideLeft' to 'outside' + increased left margin to 80)
- [x] Fix scatter plots:
  - [x] The legend overwrites the x label (increased bottom margin to 80 + Legend verticalAlign='bottom' with height=36 + XAxis label offset=30)
  - [x] Must be +150% taller (ScatterChart: h-64→h-[480px])
- [x] All points shared same x coordinate — merged into single Scatter component with Cell coloring. Previously each point was a separate Scatter series with one data point, preventing proper x-axis domain computation.
