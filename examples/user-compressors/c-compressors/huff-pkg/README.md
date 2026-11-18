# BitBench package `huff_delta`

> Visual, from-the-ground-up explanation of this codec (theory + byte layout + tunables):
> [`../../docs/huff-codec.html`](../../docs/huff-codec.html) — open it in a browser. — the Huffman-coded delta codec, in depth

This package runs **only** the lossy-then-Huffman delta codec: the "Direct
Huffman" idea from the DBDP Wearables Data Compression Toolbox
(`aascode/Data-Compression-Toolbox`), which we first evaluated offline on the
real device capture in [`../../scripts/evaluate_toolbox.py`](../../scripts/evaluate_toolbox.py)
and then implemented here in C. On that capture it produces **~20 % smaller
streams than our previous best lossy configuration** (4.014 vs 5.01
bits/sample) at the identical ±8 LSB error bound.

---

## 1. Pipeline

```
              device quantizer            delta           entropy coding
x[0..n)  ──►  Q = drop(x, N)      ──►   d = Q[i]-Q[i-1]  ──►  canonical Huffman
int64         (N = drop_bits)          (wrapping int64)      + escape symbol
              error <= 2^(N-1)                                 (zig-zag, per-chunk width)
```

The whole stream is lossless **with respect to the quantized sequence Q**; the
only loss is the quantization itself. `drop_bits = 0` therefore means fully
lossless. Everything downstream (delta, Huffman, escape) is bit-exact and
verified inside the process on every run.

### 1.1 Quantization (`hd_drop` in `src/huff_delta.h`)

```
Q = sign(x) · ((|x| + 2^(N-1)) >> N)        round-to-nearest on the magnitude
x̂ = Q << N                                  reconstruction
|x − x̂| ≤ 2^(N-1)                            hard per-sample bound
```

* Identical to the device quantizer in `apps/common.c:chunk_drop_bits`
  (the "v24 drop-bits" lossy mode of the IMU pipeline), so the package and the
  firmware behave the same way.
* Computed on unsigned magnitudes, hence overflow-safe for **every** int64
  (including INT64_MIN / INT64_MAX).
* `N = 0` returns `x` unchanged; `Q` is idempotent under re-quantization
  (`drop(Q, N) = Q`), which the verification relies on.

### 1.2 Delta and symbolization

Per 4096-sample chunk the codec stores the first (already quantized) value as
an int64, then codes the **quotient deltas**

```
d[i] = Q[i] − Q[i-1]         (wrapping int64 arithmetic, exact)
```

as symbols:

| `d` | symbol |
|---|---|
| `−K ≤ d ≤ K` and the symbol was seen in training | `d + K` (ids `0 .. 2K`) |
| anything else, or `d` in range but **unseen** in training | escape id `2K+1` |
| escape payload | `zz(d) = (d << 1) ^ (d >> 63)` in `esc_bits` bits |

Two consequences worth knowing:

* working in the **quotient** domain (not raw LSBs) divides the symbol
  magnitudes by `2^N`, so the same `K` covers a `2^N`-times wider physical
  range as `drop_bits` grows — the `drop_bits` and `table_k` knobs are not
  independent;
* deltas are taken *within* chunks (the first value is raw), so chunks are
  independent, seekable and self-delimiting — no error propagation across
  chunks and no need for a stream-wide state.

### 1.3 Table training

The Huffman table is trained on the **first 8 chunks** of the file
(`TRAIN_CHUNKS` in `src/main.c`, 32 768 samples) and then applied to the whole
file; it is transmitted once at the head of the stream.

1. Build a histogram over the `2K+2` symbols from the training chunks.
2. Add a pseudo-count of 1 to the **escape** symbol, so it always receives a
   code — otherwise a file whose training prefix contains no outlier could
   never escape later outliers.
3. Build the Huffman tree with the two-queue method (leaves sorted by count,
   then merged nodes in non-decreasing cost order). This is the optimal
   prefix code for the training histogram; measured slack over the training
   entropy is ~0.08 bits/sample on skewed streams (the earlier hand-rolled
   heap had 1.08 — it was replaced).
4. Code lengths are clamped to 64 bits and the histogram is discarded.

Training cost is part of the measured compression time; for a 12.5 MB input
it is ~0.3 % of the encode time (32 768 samples out of millions).

### 1.4 Canonical codes

Only the `2K+2` **lengths** are stored (one byte each). Both sides derive the
codes with the standard canonical recurrence, assigning codes in
`(length, symbol)` order:

```
code = 0
for l in 1..64:  code <<= 1;  for each symbol with len == l: code[s] = code++
```

The same ordering builds `sym_order[]`, which the decoder uses to map a
`(length, code offset)` pair back to a symbol. Since both sides run the same
deterministic rule, the wire format never carries code words — only lengths.

### 1.5 Escapes and the per-chunk escape width

A chunk's escapes are values outside `[-K, K]` **or** in range but unseen in
training. Before writing a chunk, the encoder makes one pre-pass over its
quotient deltas, mirrors the exact emit decision, and records
`esc_bits = max bits of zz(d)` over the escapes (minimum 1, maximum 64). That
width goes into the chunk header, and each escape writes the escape code
followed by `zz(d)` in exactly `esc_bits` bits. Consequences:

* rare outliers cost `esc_bits` bits instead of 64 (`esc_bits ≈ 13–28` on the
  capture, with 0.2–0.5 % escape rate at `K = 255`, `drop_bits = 4`);
* a chunk that is all outliers (timestamps, wide ramps) costs ~`esc_bits` bits
  per sample, still bounded and never corrupt — but see the tuning notes;
* the pre-pass is deliberately identical to the emit path (it was a bug once:
  in-range-but-unseen symbols were escaped by the encoder but not counted by
  the pre-pass, so `esc_bits` was too small and the stream desynced).

### 1.6 Container format (byte exact)

```
stream      = "HDV2" | u8 flags | [table_block] | chunk_block*
flags       = bit0 head table present, bit1 adaptive
table_block = u32 size | u8 drop_bits | u16 K | u16 nsym | u16 reserved
              | nsym × u8 length            (nsym = 2K+2)
              size = 12 + 2K + 2
chunk_block = u32 size | u32 n | i64 first | u8 esc_bits
              | bitstream of n-1 symbols
```

Every block carries its own size, so the stream is self-delimiting; a decoder
can walk it without any index. Deltas are coded for samples `1 .. n-1`; a
chunk of length 1 carries just the header.

The high bit of a chunk's `size` field flags an **exact fallback** chunk; bit
30 selects zig-zag LEB128 deltas instead of raw int64. The fallback stores the
original (not quantized) values, so it is always bit-exact and is chosen only
when it is smaller than the Huffman payload. If every chunk falls back, the
unused head table is omitted (`flags` bit0 = 0). Streams without the `HDV2`
magic are the original format and still decode (original chunk sizes have the
high bits clear).

The bitstream uses a 64-bit shift accumulator, MSB-first, flushing whole
bytes; writes wider than 32 bits are split. The writer flags overflow and
`hd_encode_chunk()` then returns 0 — the encoder can never return a partial
or corrupt payload (the destination buffer is the only failure mode, and it
is reported, not guessed).

### 1.7 Decoder

1. Parse the table block, rebuild lengths, canonical codes and `sym_order`.
2. Per chunk: read the header; decode symbols one at a time by walking lengths
   1..64, accumulating bits and testing
   `code - first_code[l] < count[l]`; on the escape symbol read `esc_bits`
   bits and un-zig-zag; otherwise `d = symbol − K`.
3. `Q[i] = Q[i-1] + d` (wrapping), `x̂ = Q << N`.

Runtime state is small: lengths (`2K+2` bytes), the per-length canonical
tables (≤ 65 entries) and the bit reader — a few hundred bytes at the default
`K = 255`. The encoder side additionally keeps a `symbol → (code, length)` LUT
(`8·(2K+2)` bytes = 4 KB at `K = 255`), which on an MCU can live in flash or
be replaced by the same canonical walk used for decoding.

### 1.8 Invariants and verification

Every run in the package and in the bench:

* decodes each chunk and requires the quantized sequence to be **exactly**
  reproduced (`dec[i] == drop(x[i], N)`);
* measures the physical error `|x − (Q << N)|` and requires it to stay within
  `2^(N-1)` (and to be exactly 0 when `drop_bits = 0`);
* rejects truncated streams, bad `esc_bits`, tables that do not parse, and
  reconstruction overflows.

Any violation aborts with a non-zero exit code instead of reporting a wrong
number. The fuzz in `src/selftest.c` (6 483 checks) exercises the same
properties plus escape-heavy paths via deliberately small tables.

---

## 2. Tunables

### `drop_bits` — number, 0..15, default **4**

The dominant rate/quality knob: it is the only lossy step.

| `drop_bits` | error bound | measured on the capture (delta, K=255) |
|---|---|---|
| 0 | exact | 8.152 b/s, CR 0.5095 |
| 2 | ±2 LSB | 5.962 b/s, CR 0.3726 |
| 4 | ±8 LSB | **4.014 b/s full / 3.957 held-out, CR 0.2509 / 0.2473** |

Rules of thumb (all measured on this capture or its entropy study,
`scripts/entropy_sa_test.py`):

* each dropped bit removes ≈1 bit/sample while the LSBs are near-uniform
  (delta entropy: 7.72 → 3.97 b/s from 0 to 4 bits dropped, average over the
  six IMU axes); the curve flattens once the low bits have been exhausted;
* the error bound is **hard** (`2^(N-1)`, mean ≈ `2^(N-2)`), unlike PRD/RMS
  metrics of transform codecs;
* choose `N` from the application tolerance, not from the ratio: for the IMU
  capture `N = 4` (±8 LSB ≈ 0.05 % of full scale) is the sweet spot used in
  the thesis comparisons;
* if you need bit-exactness use `mode: lossless` (forces `N = 0`) — but note
  that at `N = 0` this codec is *not* better than the existing Rice-based
  pipeline (8.15 vs 7.06 b/s): full-resolution residuals are heavy-tailed
  and Rice is already at their entropy bound, while the trained Huffman table
  pays escape overhead. Huffman wins **after** the LSB drop, where the
  distribution becomes spiky (many zeros, peaks at multiples of `2^N`).

### `table_k` — number, 16..2047, default **255**

Bounds the symbol set: `2K+2` symbols (ids `0..2K` plus the escape at
`2K+1`), table size `12 + 2K + 2` bytes on the wire, and `8·(2K+2)` bytes for
the encoder LUT.

| `K` | symbols | wire table | escape rate (capture, drop 4) | avg bits/sample |
|---|---|---|---|---|
| 64 | 130 | 140 B | 2.8 – 8.8 % | ≈ 4.21 |
| **255** | **512** | **524 B** | **0.19 – 0.53 %** | **≈ 3.96–4.01** |
| 1024 | 2050 | 2062 B | 0.19 – 0.26 % | ≈ 4.07 (no gain) |

* The cost curve saturates around 256 in-range symbols for this data: beyond
  that the escapes are already rare and the extra symbols only add table
  bytes. Small `K` is attractive for MCU flash but pays in escapes.
* The right `K` depends on `drop_bits`: because symbols are quotient deltas,
  larger `N` **shrinks** them, so a smaller `K` suffices at the same physical
  tolerance (`K = 255` at `N = 4` covers ±4080 LSB of the raw signal).
* For wide-delta data (timestamps, counters, ramps) most deltas fall outside
  any reasonable `K` and become escapes; there, raise `K`, or use the
  RLE-GEF/varint pipelines instead — this codec is designed for sensor-like
  signals whose quotient deltas concentrate near zero.

### `mode` — select `lossy | lossless`, default **lossy**

A convenience switch: `lossless` forces `drop_bits = 0` and checks bit-exact
reconstruction. Note that in *both* modes the delta/Huffman/escape layer is
lossless with respect to `Q`; the mode only controls the quantizer.


### `adaptive` — boolean, default **false**, and `refresh` — number 1..4096, default **64**

The offline default trains once on the first 8 chunks and transmits that
table at the head of the stream, which needs 8 chunks of lookahead. For a
device that cannot look ahead, `adaptive: true` switches to a **causal
sliding-table** stream:

* no head table, no lookahead: the first chunk carries a table trained on
  itself (bootstrap), every later chunk uses the table built from the chunks
  *before* it — the invariant is that a chunk is only ever coded with data
  the decoder already has;
* every `refresh` chunks the encoder rebuilds the table from the histogram
  accumulated since the last rebuild (`table = acc; finish_training(&table);
  reset(acc)`), and marks the update by embedding the new lengths in the next
  chunk (the `esc_bits` byte's high bit, `HD_FLAG_UPDATE`); the decoder swaps
  tables when it sees the flag. The table is trained on the *previous*
  window, so nothing needs to be buffered beyond the accumulator histogram
  (`(2K+2)·4 B = 2 KB` at `K = 255`);
* escape coding makes any mismatch harmless: a chunk coded with a stale table
  is still exact, just larger (escapes), which is the graceful degradation
  path when the signal changes.

Measured on the test files (100 k sensor-like values, drop 4):
offline prefix table 0.039736; adaptive `refresh 64` 0.039836 (one bootstrap
table, 25 chunks); `refresh 8` 0.041779 (4 updates); `refresh 1` 0.055567
(25 updates — the worst case, a table per chunk). On the full capture
(1307 chunks/axis) `refresh 64` would transmit ~20 tables per axis instead of
one: ~10 KB extra per 10.2 MiB axis (~0.1 %) to remove the lookahead.

### Compile-time knobs (not exposed in `spec.yaml`)

| knob | default | effect |
|---|---|---|
| `TRAIN_CHUNKS` (`src/main.c`) | 8 | table training scope; more chunks → fewer escapes and slightly better codes, at the cost of encode time and a table tuned to a longer prefix. The table is transmitted once either way. |
| `CHUNK_SAMPLES` / `--chunk=` | 4096 | amortization vs adaptivity: each chunk carries 8 B (first value) + 17 B (header) and re-derives nothing else. Smaller chunks adapt better to non-stationary data but pay more headers and get shorter training-relevant contexts; 4096 matches the device's sensor chunk. |
| number of axes/tables | one table per file | the bench uses one table per axis (6 streams); the package trains one table on the whole input file, which is the fair configuration for a single-sequence benchmark. |

### Tuning recipes

* **IMU / PPG / ECG-like signals** — `drop_bits: 4`, `table_k: 255`,
  `mode: lossy`. This is the measured operating point (CR 0.2509 full /
  0.2473 held-out on the capture).
* **Near-lossless** — `drop_bits: 1..2`, `table_k: 255..512`.
* **Bit-exact** — `mode: lossless`; accept that none of the lossless
  configurations beats the existing Rice/RLE-GEF pipelines on this data.
* **File smaller than ~100 KB** — the table (524 B at defaults) and the
  per-chunk headers dominate; lower `table_k` (e.g. 64) to shrink the table,
  or use a codec without a transmitted table.
* **Wide deltas** — raise `table_k` and/or `drop_bits` until escapes are
  rare, otherwise switch codec.

---

## 3. Measured results on the capture

`make bench && ./bench --drop-bits 4 --table-k 255`
(`build/sa_test_full_i16.bin`, 6 axes × 5.35 M samples):

| configuration | bits/sample | CR | max error | table |
|---|---|---|---|---|
| lossless (`drop_bits 0`) | 8.152 | 0.5095 | 0 | 524 B/axis |
| `drop_bits 2` | 5.962 | 0.3726 | ±2 | 524 B/axis |
| **`drop_bits 4`** | **4.014 full / 3.957 held-out** | **0.2509 / 0.2473** | ±8 | 524 B/axis |
| reference: RLE-GEF absolute+drop4 | 5.01 | 0.3133 | ±8 | – |
| reference: v24 delta+Rice(2,4) | ~5.1 | ~0.32 | ±8 | – |
| reference: RLE-GEF delta lossless | 8.870 | 0.5541 | 0 | – |
| reference: v23 delta+Rice lossless | 7.0569 | 0.4411 | 0 | – |

Throughput on the same run: **106 MB/s compress** (training included),
**67 MB/s decode**. All 7842 chunks round-trip verified.

Why it wins where it wins: after dropping 4 LSBs the quotient-delta
distribution is spiky (≈60 % zeros, peaks at ±1, ±2, …), which a trained
Huffman code models exactly, while Rice's geometric model wastes ~1
bit/sample there; at full resolution the same distribution is heavy-tailed
and the table/escape machinery costs more than Rice's adaptivity.

## 4. Build, test, package

```
make            # ./codec — the platform entrypoint
make selftest   # 6483 checks: quantized round trip, drop bounds, escape paths,
                # table (de)serialization, malformed payload rejection
make bench      # ./bench — reproduces the table above on the RSA1 capture
```

Upload archive (spec.yaml must sit at the archive root):

```
cd pkg/huff-pkg && zip -r ../huff-pkg.zip spec.yaml Makefile README.md src
```

The platform invocation is
`./codec -o <out.csv> --drop_bits=N --mode=… --table_k=K --options <opts.json> <input.bin>`;
the JSON wins over the flags. The CSV reports memory in bytes:
`compressor_internal` is the tracked peak of this program's own allocations,
`input_buffer` the input array and `memory_usage` their sum.
