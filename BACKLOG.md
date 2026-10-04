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

## Urgent

- [x] Add cpu info to the system info page (model, physical/logical cores, live load average, instruction sets).
- [x] Document and add an API to insert executables/scripts to introduce new compressors:
  - [x] Source structure: zip with `spec.yaml` (name, version, entrypoint, workers, options, optional build), `src/`, `Makefile` (compiled languages) or vendored python deps. Offline build at upload in the sandbox image; entrypoint contract `<entrypoint> -o <out.csv> --<option>=<value>... --options <options.json> <input.bin>` (JSON takes precedence) with the standard benchmark CSV output.
  - [x] Runner container: Debian image with python3/pip, C/C++, Go and Rust toolchains (`runner/Dockerfile`); spawned dynamically per build/run from the backend via the Docker socket; no network, non-root, read-only rootfs, CPU/memory/pids limits; files exchanged through the shared volumes.
  - [x] Multi-thread: `workers` in `spec.yaml`; global slot pool (`MAX_RUNNER_WORKERS`), runs wait for free slots, error if `workers` exceeds the maximum; container gets `--cpus=workers` and is killed + failed if cgroup throttling exceeds max(2s, 5% runtime).
  - [x] Examples (`examples/user-compressors/LANGUAGE`) for all supported languages (python, c, cpp, go, rust), validated end-to-end in CI through a real build + benchmark run.
  - [x] Roles: `admin` (everything, including groups/priorities), `professor` (manage own-group users: create/delete/reset, assign `phd`/`student`; cannot touch peers, groups or priorities), `phd` (no management access), `student` (no management access). Existing `user` accounts migrated to `student`. Permissions resolved from the DB on every request. Admin frontend gated by role (professor sees Users only).
  - [x] Compressor-upload button always visible but disabled for `student`, enforced server side. Backend upload permission enforced (`admin`/`professor`/`phd`).
  - [x] User-uploaded compressors visibility: users see ready packages of their own group (uploaded by professor/phd) plus built-ins; admin sees everything. Names are globally unique and cannot collide with built-ins.
  - [x] Frontend: Compressors page (upload with admin group selector, status pills, polling, build log, delete) and custom packages selectable in the benchmark options (Custom family).
  - [x] Documentation: `docs/user-compressors.md` (spec.yaml reference, invocation/CSV contract, vendored dependencies with pip `--target`, static libs for C/C++, Go `-mod=vendor`, Cargo vendoring, `-march=native`/`-C target-cpu=native` and checking instruction sets on the Status page) plus README links.

## Benchmark scheduling

- [x] Average mode: multiple selected files become one benchmark, normalized to `.bin` at upload and fanned out as per-`.bin` tasks over a unified CPU worker budget (`MAX_PARALLELISM`, default allocatable cores). Custom `(bin × package)` tasks cost their declared `workers`. Claim order: group priority, then fewest running worker units per benchmark, best-fitting task; no preemption; per-task retries; crash recovery; graceful cancellation. `MAX_RUNNER_WORKERS` removed.
- [x] Upload page: file list shows at most five rows with scrolling and per-file remove.

## Remaining (future)

- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)
- [ ] Add `--cap-add=SYS_PTRACE` or `seccomp=unconfined` to docker-compose for Valgrind

# Bugs
