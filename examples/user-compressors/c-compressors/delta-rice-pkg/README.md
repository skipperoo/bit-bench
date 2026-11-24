# `delta_rice` — Delta-Rice (BitBench package)


Delta + Rice: per batch of 199 samples an int16 anchor, then zig-zag first differences in Rice blocks of 64 with the exhaustive best k (4-bit header). drop_bits > 0 is the lossy_qshift quantiser.

- **Level:** `drop_bits` (0..7, default 2): LSB drop d before coding, reconstruction q << d, |err| <= 2^(d-1); 0 = lossless.
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
- **Memory (codec):** no workspace; encoder stack 376 B, decoder 176 B (lib/v23_rice.h).
- **Build:** `make`; **test:** `make selftest && ./selftest`.

Wrapper: `src/main.c`, `src/selftest.c` (shared by the thesis packages,
`scripts/pkg_template/`), `src/adapter.h` (this codec's binding).
