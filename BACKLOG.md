# BitBench — Backlog

- [x] done
- [ ] open

# Todo

## Compare and result export

- [x] Compare page integrated into ResultsPage: "Compare" button enters select mode, card checkboxes with max limit (env MAX_COMPARE_BENCHMARKS, default 5), "Compare (N)" button navigates to `/compare?ids=a,b,c`.
- [x] Comparison detail page (`/compare?ids=a,b,c`) shows:
  - Grouped compression ratio bar chart (compressor on x, grouped by benchmark).
  - Per-metric tables: rows = benchmarks, columns = compressors, last row = average. Rank styling (bold best, underline 2nd, italic 3rd).
  - Copy LaTeX button on each table.
- [x] Copy LaTeX on DetailPage ranked tables (per-metric, with rank styling matching `generate_full_html_report.py`).
- [x] Shared LaTeX utility (`lib/latex.ts`) with `buildLatexTable` and `copyToClipboard`.
- [x] Shared format utilities moved to `lib/format.ts` (formatBytes, formatMetricValue).

## Remaining (future)

- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)
- [ ] Add `--cap-add=SYS_PTRACE` or `seccomp=unconfined` to docker-compose for Valgrind

# Bugs
