# `nlms_cm` — BitBench package

NLMS-CM from `lib/nlms_cm.h` (sources vendored unchanged in `src/`): the DPCM
error-bounded grid `q = 2*epsilon + 1` (`epsilon = 0` is lossless), an integer
NLMS 16+4 cascade (or plain delta) predictor on the quantised index stream,
two context models mixed in the logistic domain and an LZMA-style binary range
coder. Integer-only; the logistic tables are constants (`src/nlms_cm_tables.c`).

| `predictor` | prediction of the index `y[t]` | when |
|---|---|---|
| `nlms` (default) | 16-tap NLMS on `y` + 4-tap NLMS on its error, Q20, update every 64 samples | lossless and small `epsilon`; best on IMU |
| `delta` | `y[t-1]` | coarse grids where the indices are short (PPG at `epsilon >= 2` in the lib bench) |

> Visual, in-depth explanation (grid, NLMS, contexts, mixing, range coder,
> byte layout, measured results):
> [`../../docs/explained/nlms-cm.html`](../../docs/explained/nlms-cm.html)

- Input: standard `.bin` sequence (8- or 16-byte header, int64 values).
- Output: `num_values = N`, `uncompressed_bits = 64*N`, compressed bits from
  the real payload (all headers included); max/mean error, coded-chunk and
  model-reset counts printed on stderr.
- Chunking: 4096 values, base + int16 offsets, one lane. NLMS-CM is not
  translation-invariant (the NLMS history and the grid see absolute offsets),
  so the base is **sticky**: one global base when the whole sequence spans
  at most 65,536 values (0 when it already fits int16), otherwise the current
  base is kept while chunks fit around it and a new chunk-centred base resets
  the model. Each chunk uses the smaller of the NLMS-CM payload and an exact
  fallback (zig-zag LEB128 deltas or raw int64), so out-of-range chunks never
  expand. The encoder snapshots the model before each chunk and restores it
  when the fallback wins, so exact chunks leave the model untouched on both
  sides. Every decoded value is within `epsilon` LSB of the input (exact
  chunks have error 0).
- Stream: `NLCM` version 1, `u8 predictor`, `u32 epsilon`, `u32 N` (16 B);
  per chunk `u8 mode | u8 flags | u16 0 | i64 base | u32 len | payload`
  (16 B). Mode 0 = raw int64, 1 = NLMS-CM chunk (`nlms_cm_encode_chunk`, its own
  12-byte header), 2 = LEB128 exact fallback; flags bit 0 = re-initialise the
  NLMS-CM state before decoding. The stream must be decoded in order (adaptive
  model, no random access, no checksum).
- Memory: two 5,328 B models (encoder and decoder, plus one encoder snapshot)
  and `sizeof(nlms_cm_state)` = 2,864 B per state (ring-buffer histories of the
  speed-optimised `nlms_cm.c`, byte-identical output); the device needs one model and
  one state. 16 KiB of constant tables.
- Options: `epsilon` (0..32767, default 8), `predictor` (`nlms` default,
  `delta`), `mode` (`lossy` default, `lossless` forces `epsilon = 0`). JSON
  options take precedence over flags.
- Build: `make`; test: `make selftest && ./selftest`.

Measured with this package on full-length capture axes (5,353,310 values,
1307 chunks, all NLMS-CM-coded, one model reset; bits per sample including every
header):

| axis | NLMS-CM lossless | `v23_rice` lossless | NLMS-CM `epsilon=8` | `dpcm_range --coder=range` `epsilon=8` |
|---|---:|---:|---:|---:|
| `acc_x` | **6.611** | 6.958 | **2.840** | 2.905 |
| `gyr_x` | **7.121** | 7.611 | **3.479** | 3.646 |

Throughput on the host is 18–34 MB/s over the 8-byte int64 input (not
comparable to the int16 bench MB/s). The six-axis library numbers (one
3-lane stream per triad: 6.596 b/s lossless, 2.983 b/s at `epsilon=8`) are in
[`../../docs/research.md`](../../docs/research.md) §20; BitBench sequences are
one-dimensional, so the package always codes a single lane.

On the 4096-value package corpus the raw PPG samples span more than 16 bits
per chunk and take the exact fallback, exactly like `dpcm_range` and
`nlms_rice`.
