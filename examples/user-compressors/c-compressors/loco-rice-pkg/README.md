# `loco_rice` — LOCO-Rice (BitBench package)

**LOCO-Rice** as named in the thesis, packaged from the exact implementation the
benchmark ran: `src/loco_rice.c` and headers are vendored unchanged from `lib/`
(`firmware/stm32wb_mcu_bench/src/` carries the same files). Regenerate with
`python3 scripts/make_thesis_packages.py`; do not edit the copies here.

1-D JPEG-LS (LOCO-I): median/edge predictor on the reconstructed samples, 24 contexts with bias correction, near-lossless quantisation of the residual with step 2*eps + 1 inside the prediction loop, adaptive Rice codes. The context state carries across chunks (snapshotted when a chunk falls back).

- **Level:** `epsilon` (0..255, default 2): the hard per-sample error bound eps (step 2*eps + 1); 0 = lossless.
  `mode=lossless` forces 0. JSON options win over flags.
- **Input:** standard `.bin` sequence (8- or 16-byte header, int64 values).
- **Output:** CSV row with `num_values = N`, `uncompressed_bits = 64*N` and the
  compressed bits of the real stream (every header included). The stream is decoded
  in-process and every value checked against the bound; max/mean error, coded-chunk
  and state-reset counts go to stderr.
- **Chunking:** 4096 values, base + int16 offsets, one lane (the codecs work on int16,
  as on the device). The base is sticky: one global base when the whole sequence spans
  at most 65,536 values (0 when it already fits int16), otherwise it is kept while chunks
  fit around it and a new chunk-centred base restarts the codec state. Each chunk uses
  the smaller of the codec payload and an exact fallback (zig-zag LEB128 deltas or raw
  int64), so out-of-range chunks never expand.
- **Stream:** `magic[4] | u8 version 1 | u8 level | u16 0 | u32 0 | u32 N` (16 B); per
  chunk `u8 mode | u8 flags | u16 0 | i64 base | u32 len | payload` (16 B). Mode 0 = raw
  int64, 1 = codec chunk, 2 = LEB128 exact fallback; flags bit 0 = start a fresh codec
  state. Decode in order; no checksum.
- **Memory (codec):** sizeof(loco_rice_state) = 308 B per side, no workspace.
- **Build:** `make`; **test:** `make selftest && ./selftest`.

Wrapper: `src/main.c`, `src/selftest.c` (shared by the thesis packages,
`scripts/pkg_template/`), `src/adapter.h` (this codec's binding).
