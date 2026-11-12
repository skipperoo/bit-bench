# UI refactor proposal

Status: **proposal**, nothing below is implemented yet (except where marked
*done*). It builds on the current pages, `DESIGN.md` ("The Lab Bench") and the
Revision 7 features (standardized datasets, aggregation, custom-coder colours).

## Problems today

1. **The upload page does everything in one long column** (≈1100 lines of
   `UploadPage.tsx`): name → data → run settings → presets & history → the
   two-pane compressor builder → submit. The submit button sits below a
   60-instance builder; presets/history push the builder off-screen; there is no
   summary of what will run.
2. **Results is a flat card grid.** No filters beyond a name search, no sort, no
   status filter, no way to see a chunk sweep (`std · 768`, `gap · 768`, …) as
   one experiment. Comparing means toggling a select mode and ticking cards.
3. **Detail and Compare are two different renderers** of the same data: Detail
   has charts + ranked tables + Pareto; Compare has only one grouped bar chart and
   tables. Compare cannot show scatter/Pareto, Detail cannot add a second
   benchmark.
4. **Charts don't scale with instances.** With 20+ configurations, x-axis labels
   overlap, legends wrap into walls, and several instances of one algorithm
   share a colour (*done*: shades per configuration + custom-coder palette).
5. **No sense of a run in progress.** A card shows a percentage; there is no
   per-input/task view, no ETA, no log of warnings until the run ends.
6. **Inconsistencies with DESIGN.md**: cards use `hover:shadow-md` (the Flat
   Rule forbids shadows); status colours are re-declared in three places; ad-hoc
   `▶/▼` accordions instead of the Shadcn accordion already in `components/ui`.

## Proposed information architecture

```
Experiments ── New experiment (wizard)
            ├─ Experiment list (table)      ← replaces "Results"
            └─ Experiment view               ← replaces Detail + Compare
Compressors ── Built-ins (read-only catalogue) + Custom packages
Datasets    ── Standardized datasets browser (new)
Status
```

An **experiment** is one submission: a single upload, or a dataset run that
fans out into N benchmarks (transform × chunk size). Backend change: add an
`experiment_id` (or reuse a `group_key`) on `benchmarks`, set by
`POST /benchmarks/dataset` and by "Run separate benchmarks" uploads.

## Page by page

### 1. New experiment: three-step wizard with a sticky summary

```
┌ Steps ───────────────┐┌ Step content ─────────────────────┐┌ Summary (sticky) ─┐
│ 1 Data          ✓    ││                                    ││ wildppg, 7 series │
│ 2 Compressors   ●    ││  (picker | configured instances)   ││ 768 × ≤10, std+gap│
│ 3 Run settings       ││                                    ││ → 2 benchmarks    │
└──────────────────────┘└────────────────────────────────────┘│ 12 instances      │
                                                              │ pooled · no Massif│
                                                              │ est. 240 tasks    │
                                                              │ [ Run ]           │
                                                              └───────────────────┘
```

* **Data**: tabs *Upload files* / *Standard dataset* (*done* as a switch), with
  the plan box moved into the summary.
* **Compressors**: the existing two-pane builder full width. Presets and
  history become a **"Load…" menu** at the top of the instance list instead of
  two cards above it. Family filter chips, "add all in family", bulk
  remove.
* **Run settings**: aggregation, memory, and a cost estimate (tasks × instances,
  "Massif ≈ ×20").
* The summary panel always shows the Run button and the validation reason, so
  submission never needs scrolling. Mobile: summary collapses into a bottom bar.

### 2. Experiment list: a dense table instead of cards

| ☐ | Name | Data | Compressors | Status | Created | Duration |
|---|---|---|---|---|---|---|
| ☐ | wild acc ▸ (2) | wildppg · 768 × ≤10 · std, gap | 5 | ● ready | 12 Nov | 3m |

* Rows group the benchmarks of one experiment (expandable).
* Filters: status, data source (upload/dataset/dataset name), compressor,
  date; sort by any column; URL-synced query string.
* Selection checkboxes are always visible; a bulk bar offers **Compare**,
  **Delete**, **Re-run with same config**.
* Matches DESIGN.md "high density on results pages".

### 3. Experiment view: one renderer for one or many benchmarks

Detail and Compare merge: the view takes `?ids=a,b,…` (one id = today's
detail page).

* **Header**: name(s), data source line, aggregation, warnings, emulation
  notice, "Add benchmark to comparison" picker.
* **Sweep mode** (benchmarks of one dataset experiment): line charts of each
  metric vs chunk size, one line per compressor, faceted by transform: the
  thesis "scaling" plots generated in-app.
* **Metric tabs** instead of accordions (Ratio, Bits/element, Throughput,
  Memory, Random access, Range queries). Each tab: chart + ranked table +
  "Copy LaTeX"/"Download CSV".
* **Pareto tab**: ratio vs throughput scatter with the Pareto front drawn as a
  step line; the top-5 table moves here.
* **Instance filter**: a sidebar checklist of compressors/instances with
  family toggles and colour swatches; charts and tables follow it. This fixes
  unreadable charts with many instances.
* Horizontal bar charts when there are more than ~12 bars (labels stay
  readable), virtualized legends.

### 4. Datasets page (new)

Browse `DATASET_DIR`: per series length, decimals, value range, a sparkline
(first 10k samples) and the chunk counts for each preset size. "Benchmark
this dataset" pre-fills the wizard. Shows invalid files with the reason, plus
the setup instructions when empty.

### 5. Compressors page

One catalogue for built-ins and custom packages: family, colour swatch,
options with defaults and ranges, platform/emulation badge, build status. The
upload form moves into a drawer.

### 6. Live run view

While a benchmark runs, the experiment view shows a task table (input,
compressor kind, status, duration), running warnings, and an ETA from the
mean task duration. Needs `GET /benchmarks/{id}/tasks` (the rows exist until
finalize).

## Shared building blocks

* `StatusPill`, `MetricChart`, `RankedTable`, `CompressorSwatch`,
  `InstanceFilter`, `DataSourceLine`: extracted from the pages so that list,
  view and wizard share them (today status colours and metric labels are
  duplicated).
* Shadcn `Tabs`, `Accordion`, `Sheet` (drawer), `Command` (searchable picker).
* Remove shadows; one z-index scale per DESIGN.md.

## Suggested order

1. Extract shared components and fix the DESIGN.md violations (no behaviour
   change).
2. Experiment list table with filters, plus `experiment_id` in the backend.
3. Merge Detail/Compare into the experiment view (metric tabs, instance
   filter, Pareto tab).
4. Wizard with sticky summary.
5. Sweep charts, Datasets page, live run view.

Each step is shippable on its own and keeps the API backwards compatible.
