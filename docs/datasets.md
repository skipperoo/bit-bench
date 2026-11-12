# Standardized datasets

BitBench can benchmark compressors on **standardized datasets** stored on the
server, with the same chunk sizes, transforms and per-signal chunk selection
as the thesis experiments (`gef-experiments/run_all_benchmarks.sh`). Instead of
pre-cutting `datasets/<std|gap|gap_shifted>/size_<N>/*.bin` folders, you store
each recording **once, whole**, and choose the chunking per run in the UI.

## 1. Where the files go

`docker-compose.yml` mounts the repository's `./datasets` folder read-only into
the backend:

```yaml
backend:
  environment:
    - DATASET_DIR=/data/datasets
  volumes:
    - ./datasets:/data/datasets:ro
```

Layout: one folder per dataset, one `.bin` per full series.

```
datasets/
├── wildppg/
│   ├── dataset.yaml            # optional
│   ├── sternum_ecg.bin
│   ├── wrist_acc_x.bin
│   └── wrist_ppg_g.bin
├── pamap2/
│   └── wrist_gyro_z.bin
└── finance/
    ├── NVDA.bin
    └── SPCX.bin
```

* Any integer data works: sensor channels, prices in cents, counters, IDs, …
* Names may use letters, digits, `.`, `_`, `-` (no leading dot).
* Files are re-scanned on every request: add or replace files without
  restarting. Invalid files are listed in the UI with the reason and cannot be
  selected.
* `dataset.yaml` (optional):

  ```yaml
  description: "Daily closing prices, in cents"
  source: "Exchange XYZ, 2015-2024"
  ```

`datasets/*` is git-ignored (except its README) and excluded from the Docker
build context, so large recordings never end up in commits or images.

## 2. File format

The BitBench `.bin` format, little endian:

| Bytes | Field |
|:--|:--|
| 8 | `uint64 N`, number of values |
| 8 | `uint64 decimals`, decimal digits encoded in the integers (0 for plain integers) |
| 8·N | `int64` values |

The 8-byte header without `decimals` (`N` + values) is accepted too. The header
`N` must match the file size exactly.

`decimals` matters for the floating-point compressors (Gorilla, Chimp,
Chimp128, TSXor, Elf, Camel, Falcon, ALP), which see `value / 10^decimals`.
Store prices of `48.12` as `4812` with `decimals = 2`.

**Use `decimals = 0` for integer data** (ADC codes, counters, IDs). Every
floating-point compressor runs on it. Earlier datasets used `decimals = 1` as a
workaround because Camel broke at 0 (fixed: Camel always encodes at least one
decimal digit). The workaround is not free: dividing integers by 10 creates
values like `4812.3` that have no exact binary form, which made Gorilla, Chimp
and Elf compress 2–4× worse on integer sensor data (ALP and Falcon are
unaffected).

Doubles hold integers exactly only up to ±2^53. For larger values the
conversion itself loses information, so floating-point compressors cannot be
lossless; they still run, but their results are marked as having failed the
self-test (below).

## 3. Creating the files

All scripts live in `scripts/datasets/` and need Python 3 with NumPy (pandas
for CSV, SciPy for WildPPG). They write to `./datasets` by default (`--out` to
change it).

### Sample data

```bash
python3 scripts/datasets/make_synthetic.py
```

Writes `datasets/synthetic/` (five deterministic 1M-value series: sine + noise,
random walk, sawtooth, steps, white noise), so you can try the feature
right away.

### Your own data: `make_dataset.py`

```bash
# every numeric column of a CSV becomes a series (non-numeric columns are skipped)
python3 scripts/datasets/make_dataset.py csv sensors.csv --dataset lab

# chosen columns, floats kept to 2 decimals (stored as int64 × 100, decimals=2)
python3 scripts/datasets/make_dataset.py csv prices.csv --dataset finance \
    --columns NVDA,SPCX --decimals 2 --missing ffill

# long format: one row per (symbol, timestamp, close) -> one series per symbol
python3 scripts/datasets/make_dataset.py csv ticks.csv --dataset finance \
    --group-by symbol --value close --sort-by timestamp --decimals 2

# NumPy arrays (one series per file) or plain text (one value per line)
python3 scripts/datasets/make_dataset.py npy a.npy b.npy --dataset arrays
python3 scripts/datasets/make_dataset.py text counts.txt --dataset web
```

Options: `--decimals N` multiplies every value by 10^N and stores N in the
header (without it, inputs must already be integers; fractional values are
refused rather than truncated). `--missing error|drop|ffill` handles empty/NaN
cells (default: refuse). `--description/--source` write `dataset.yaml`.
`--force` overwrites existing series.

### Thesis datasets: `export_thesis_datasets.py`

```bash
python3 scripts/datasets/export_thesis_datasets.py wildppg /path/to/WildPPG.mat
python3 scripts/datasets/export_thesis_datasets.py pamap2  /path/to/PAMAP2_Dataset/Protocol
```

The same ADC projections as `convert_ds_full.py` (WildPPG PPG 19-bit,
accelerometer 10-bit, ECG raw 18-bit codes; PAMAP2 hand IMU 13-bit
accelerometer/gyroscope), but each signal is written whole, with
`decimals = 0` by default (`--decimals N` to change it; `--decimals 1`
reproduces the header of the thesis files):
`wildppg/{sternum_ecg,wrist_ppg_g,wrist_ppg_r,wrist_ppg_ir,wrist_acc_x,wrist_acc_y,wrist_acc_z}.bin`
and `pamap2/wrist_{acc,gyro}_{x,y,z}.bin`.

* **WildPPG** chunks cut by BitBench contain exactly the values of the thesis
  `std` and `gap` files (verified on all 938 chunk files of the default export; byte-identical with
  `--decimals 1`; re-run with the opt-in `TestThesisEquivalence` in
  `backend/internal/dataset/thesis_test.go`).
* **PAMAP2** concatenates its NaN-free runs into one series. For large chunk
  sizes this equals the thesis fallback; for small sizes the thesis cut each run
  separately, so chunks can differ.

**Every signal: `--all-signals`, `--exclude PATTERN`.** By default only the
thesis signals above are written. `--all-signals` writes every signal instead,
and `--exclude` (repeatable shell pattern on the series name) drops some:

```bash
# WildPPG without accelerometers, PAMAP2 subject 101 without the heart rate
python3 scripts/datasets/export_thesis_datasets.py wildppg /path/to/WildPPG.mat --all-signals --exclude '*_acc_*'
python3 scripts/datasets/export_thesis_datasets.py pamap2 /path/to/Protocol/subject101.dat --all-signals --exclude heart_rate
```

| Dataset | Series | Integer projection |
|:--|:--|:--|
| WildPPG | `<site>_ppg_{g,r,ir}` for `sternum, head, ankle, wrist` (128 Hz) | value × 2^19, clipped to 19 bits (the stored fractions are exact multiples of 2^-19) |
| WildPPG | `sternum_ecg` (128 Hz) | raw 18-bit ADC codes, unchanged |
| WildPPG | `<site>_altitude` (0.5 Hz) | 19 bits over [0, 4096) m: 1/128 m |
| WildPPG | `<site>_temperature` (0.5 Hz) | 19 bits over [0, 64) °C: 1/8192 °C |
| WildPPG | `<site>_acc_{x,y,z}` | 10-bit codes (8 mg) |
| PAMAP2 | `{wrist,chest,ankle}_temperature` | native 1/16 °C steps (lossless) |
| PAMAP2 | `…_acc_{x,y,z}` / `…_acc6_{x,y,z}` | 13-bit codes over ±16 g / ±6 g (the ±6 g sensor saturates on impacts) |
| PAMAP2 | `…_gyro_{x,y,z}` | 13-bit codes over ±2000 °/s |
| PAMAP2 | `…_mag_{x,y,z}` | 0.1 µT steps |
| PAMAP2 | `heart_rate` | bpm (only the valid ~9 Hz samples) |

The PAMAP2 hand IMU is named `wrist`; its orientation columns are skipped
(invalid in this collection). `dataset.yaml` describes what was written.
* **gap_shifted** is the corrected transform (below) and intentionally differs
  from the thesis files.

### Any other tool

Anything that writes the format works, e.g. NumPy:

```python
import numpy as np, struct
values = np.asarray(series, dtype="<i8")
with open("datasets/mydata/signal.bin", "wb") as f:
    f.write(struct.pack("<QQ", values.size, 0))  # N, decimals
    f.write(values.tobytes())
```

## 4. Running a dataset benchmark

On **New Benchmark**, switch the data source to **Standard dataset**:

| Control | Meaning |
|:--|:--|
| Dataset / Series | Which recordings to use (all valid series are preselected). |
| Chunk size (samples) | `whole series` benchmarks each recording as one input; numbers cut it into fixed-length chunks (a trailing partial chunk is dropped). Presets match the thesis sizes: `size_<B>` counts bytes of the original 16-bit stream, so it is **B / 2 samples** (512→256, 1536→768, 8192→4096, 16384→8192, 32768→16384, 65536→32768, 1572864→786432). Custom sizes are allowed. |
| Max chunks per series | Keep at most this many chunks, evenly spaced over the recording (numpy `linspace(...).round()`, like `MAX_CHUNKS_PER_SIGNAL = 10`). `0` keeps every chunk. |
| Transform | `std` values as recorded; `gap` first value then differences; `gap_shifted` see below. |

Every **(transform × chunk size)** combination becomes its own benchmark named
`<name> · <transform> · <chunk>`, mirroring one
`datasets/<type>/size_<N>` folder of `run_all_benchmarks.sh`. Select them on
the Results page and use **Compare** to see the sweep side by side. The plan
box shows how many benchmarks and inputs a run creates before you submit.
Limits: 32 benchmarks per request, 5000 inputs per benchmark.

Series shorter than one chunk are skipped and reported as a benchmark warning.

### Transforms

For a chunk `x[0..n-1]`:

| Transform | Output |
|:--|:--|
| `std` | `x[i]` |
| `gap` | `x[0]`, then `x[i] − x[i−1]` |
| `gap_shifted` | `x[0] − min(x)`, then `(x[i] − x[i−1]) − min_i(x[i] − x[i−1])` |

`gap_shifted` makes every value non-negative (useful for compressors that
assume unsigned input). The two offsets (`min(x)` and the minimum gap) are side
information the `.bin` format has no room for, so they are not stored (16
bytes per chunk if a decoder needed them). The thesis script's version was
buggy: it discarded the prepended offset and used the minimum of the original
values instead of the minimum gap.

## 5. Aggregation and memory (all benchmarks)

**Run Settings** apply to uploads and dataset runs alike.

**Aggregate results over inputs**: how the per-input rows of a compressor
(chunks, files, CSV columns, archive members) become its single result row:

| Method | Definition |
|:--|:--|
| Mean (default) | Arithmetic mean of every metric. Same as before this option existed. |
| Median | Per-metric median: robust to a few outlier chunks. |
| Pooled | All inputs treated as one dataset: value counts and bit sizes are summed, ratio = Σcompressed bits / Σuncompressed bits, compression/decompression throughput = total values / total time (value-weighted harmonic mean), random-access and range-query throughputs are harmonic means (each input runs the same number of queries), latencies and memory metrics are means. |

Pooled is the choice to compare with "compress the whole dataset" numbers;
mean matches the thesis tables, which average per-chunk metrics.

**Memory measurement** runs every built-in compressor a second time under
Valgrind Massif to measure peak memory. It is far slower than the benchmark
itself; switch it off for large chunk sweeps (the memory metrics are then
empty).

## 6. Self-test

The harness checks every compressor's output: the decompressed sequence must
equal the input. A failing compressor is **still reported** (so its numbers can
be inspected) but marked:

* the harness CSV has a trailing `self_test` column (`ok`/`failed`) and logs
  the reason (`<name> self-test failed: decompressed value differs at index 17`);
* BitBench stores, per result, on how many inputs the self-test failed
  (`self_test_failures`), shows a red **self-test failed** badge next to the
  compressor, and adds a benchmark warning with the reason and the input.

Floating-point compressors also fail the self-test when the input integers are
not exactly representable as doubles (|value| beyond 2^53 / 10^decimals).
User packages may emit the same optional `self_test` column.

## 7. API

* `GET /api/v1/datasets` → `{datasets: [{name, description, source, series: [{name, values, decimals, size_bytes, error?}]}], transforms, max_runs, max_inputs_per_run, max_chunks_per_series}`
* `POST /api/v1/benchmarks/dataset` with JSON
  `{name, dataset, series?, chunk_sizes?, max_chunks, transforms?, aggregation?, measure_memory?, compressors}`
  → `201 {benchmarks: [...]}`. `chunk_sizes` defaults to `[0]` (whole series),
  `transforms` to `["std"]`, `series` to every valid series.
* `POST /api/v1/benchmarks` (uploads) accepts the optional form fields
  `aggregation` and `measure_memory`.

Benchmarks created from a dataset carry
`source: {kind: "dataset", dataset, series, chunk_size, max_chunks, transform, inputs}`.
