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
- [ ] Document and add an API to insert executables/scripts to introduce new compressors:
  - [ ] Fix the source structure: zip with inside `src`, `Makefile` if compilation is needed or requirements.txt if a python script is provided, `spec.yaml` a spec file where the user specifies the available options (something like the already present object to govern the ui rendering for compressors parameters) and the entrypoint command. The input parameters and the ouput format must be fixed to the ones of the original losses benchmark.
  - [ ] Add a runner container where the user provided benchmark can be run in a constrianed environment (fix it to a full debian contianer with latest python3/pip support and c/c++, golang and rust toolchain installed so that the user can use those languages). The runner container must talk with the original container to gather the result and the containers must be spawned dynamically based on the workers available.
  - [ ] Multi-thread implementations must specify the workers requirements in the spec.yaml and wait for available workers to free up or return an error if the worker requirements are over the maximum available
  - [ ] Provide examples (`examples/user-compressors/LANGUAGE`) for each supported language to be compressed and uploaded to the platform
  - [x] Roles: `admin` (everything, including groups/priorities), `professor` (manage own-group users: create/delete/reset, assign `phd`/`student`; cannot touch peers, groups or priorities), `phd` (no management access), `student` (no management access). Existing `user` accounts migrated to `student`. Permissions resolved from the DB on every request. Admin frontend gated by role (professor sees Users only). Upload permissions for custom compressors still to come with the compressor API.
  - [ ] Compressor-upload button always visible but disabled for `student`, enforced server side.
  - [ ] User-uploaded compressors are not universally show to all users: users within the same group (think of it as a research group) see the compressors available by default plus the ones uploaded by phd and professor of the same group. Admin can see everything.

## Remaining (future)

- [ ] E2E tests (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] Production hardening (HTTPS, healthcheck, monitoring)
- [ ] Add `--cap-add=SYS_PTRACE` or `seccomp=unconfined` to docker-compose for Valgrind

# Bugs
