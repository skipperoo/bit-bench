/*
 * pfordelta.h — PForDelta codecs for int16 chunks: NewPFor, OptPFor and
 * Simple8b-RLE.
 *
 * C11 ports of the two FastPFOR codecs benchmarked in the thesis experiments
 * (reference/gef-experiments: "pfordelta_newpfor" =
 * CompositeCodec<NewPFor<4, Simple16<false>>, VariableByte>,
 * "pfordelta_simple8b_rle" = Simple8b_RLE<true>), re-packed for 16-bit
 * input. All three codecs are lossless; a lossy mode is the caller's drop-bits
 * quantizer applied before encoding (as for RLE-GEF).
 *
 * Delta transform (per chunk, chunks are independent). With prev = 0:
 *
 *   d[i] = x[i] - prev,  prev = x[i]
 *   u[i] = zigzag(d[i]) = (d << 1) ^ (d >> 31)
 *
 * so u[0] = zigzag(x[0]). The delta width is the encoder's choice:
 *
 *   PFD_DELTA_WRAP16  d is taken mod 2^16 (int16 wrap-around); every code
 *                     fits 16 bits (u <= 65535).
 *   PFD_DELTA_FULL17  d is the exact int32 difference in [-65535, 65535];
 *                     codes need up to 17 bits (u <= 131070).
 *
 * The decoder rebuilds x[i] = prev + unzigzag(u[i]) mod 2^16, which inverts
 * both modes, so the payload carries no mode flag. Every code must be below
 * 2^PFD_MAX_CODE_BITS.
 *
 * pfordelta_newpfor — NewPFD (Yan, Ding, Suel, WWW'09), FastPFOR layout
 * narrowed to 16/17-bit codes. The chunk is split into n/128 blocks of
 * PFD_BLOCK_SIZE codes plus an n%128 tail:
 *
 *   block  u16 header  b:5 (bits 15..11) | nexc:4 (10..7) | 0:2 (6..5) |
 *                      excw:5 (4..0)
 *          excw x u32  Simple16 words: nexc position gaps (pos - prev - 1,
 *                      first = pos) then nexc high parts ((u >> b) - 1)
 *          16*b bytes  128 low parts (u & (2^b - 1)), b bits each, packed
 *                      LSB-first (FastPFOR fastpack bit order)
 *   tail   VariableByte: 7 bits per byte, low group first, 0x80 marks the
 *          last byte of a value; zero-padded to an even length.
 *
 * b is the smallest of {0..13, 16, 17} leaving at most 10 % of the block as
 * exceptions (nexc * 10 <= 128, so nexc <= PFD_NEWPFOR_MAX_EXCEPTIONS);
 * b = 17 has none. Compared with FastPFOR the per-chunk block count, the
 * b = 20/32 options and the 32-bit block header are gone, and the tail pads
 * to 16 instead of 32 bits. All fields are little-endian.
 *
 * pfordelta_optpfor — PFOR with a cost-optimal b per block (the OptPFD idea
 * of Yan, Ding, Suel, WWW'09) and fixed-width exceptions, so the exact
 * size of every candidate b follows from the block's bit-width histogram
 * and all of them are tried. Same 128-code blocks, b candidates, low-part
 * packing and VariableByte tail as NewPFor:
 *
 *   block  u16 header  bi:4 (bits 15..12, b = {0..13,16,17}[bi]) |
 *                      nexc:7 (11..5, <= 127) | hb:5 (4..0)
 *          exceptions  if nexc: LSB-first bit stream, zero-padded to a byte:
 *                      positions as nexc 7-bit indices if 7*nexc < 128,
 *                      else a 128-bit bitmap (bit j of byte j/8); then
 *                      nexc high parts ((u >> b) - 1) of hb bits each,
 *                      hb = bit width of the largest
 *          16*b bytes  128 low parts, as NewPFor
 *   tail   VariableByte, as NewPFor.
 *
 * The exception-free block (b = 16 or 17) is always a candidate, so a block
 * never exceeds 2 + 16*17 bytes. Ties go to the larger b. Compared with
 * NewPFor: smaller payloads (one outlier no longer forces a wide b, and
 * many exceptions are cheap), no Simple16, decoding with a bit reader for
 * the exceptions.
 *
 * pfordelta_simple8b_rle — Simple8b with run-length selector (Anh, Moffat
 * 2010; FastPFOR Simple8b_RLE), 64-bit little-endian words, selector in
 * bits 63..60:
 *
 *   selector  1  2  3  4  5  6  7  8  9 10 11 12 | 15
 *   codes    60 30 20 15 12 10  8  7  6  5  4  3 | run
 *   bits      1  2  3  4  5  6  7  8 10 12 15 20 | count:43 (59..17),
 *                                                  value:17 (16..0)
 *
 * Packed codes sit LSB-first (code j at bit j*bits); the last word of a
 * chunk may hold fewer codes than the selector capacity, with zero filler.
 * Selectors 0, 13 and 14 (FastPFOR: end marker, 2 x 30 and 1 x 60 bits) are
 * not used for <= 17-bit codes and are rejected; the RLE value field is
 * narrowed from 32 to 17 bits and the leading u32 element count is dropped.
 * The encoder is FastPFOR's greedy one: a run is coded when
 * bits(value | 1) * run >= 60, otherwise the first selector whose capacity
 * (clipped to the remaining codes) fits is taken.
 *
 * Neither payload stores n: the caller frames chunks (length + payload) and
 * passes n to the decoder. Decoders validate every header field, code range,
 * filler bit and the exact payload length; they never write past n samples.
 *
 * Memory: no heap, no workspace, no static state. Stack only: the NewPFor
 * encoder/decoder hold one block's exceptions (24 x u32); the Simple8b-RLE
 * encoder holds a 60-code lookahead window (60 x u32 + 60 B), its decoder a
 * few locals. Measured with gcc -O3 -fstack-usage on x86-64: NewPFor
 * encode/decode ~200/136 B, OptPFor encoder holds the block's 128 codes
 * (512 B), its decoder a few bit readers, Simple8b-RLE encode/decode ~300/56 B.
 */
#ifndef PFORDELTA_H
#define PFORDELTA_H

#include <stddef.h>
#include <stdint.h>

#define PFD_DELTA_WRAP16            0
#define PFD_DELTA_FULL17            1

#define PFD_MAX_CODE_BITS           17
#define PFD_BLOCK_SIZE              128
#define PFD_NEWPFOR_MAX_EXCEPTIONS  12      /* floor(128 / 10)             */
#define PFD_NEWPFOR_HEADER_BYTES    2
/* Worst block: header + one Simple16 word per exception field + 16 low-bit
 * planes (b = 16 with 12 exceptions; b = 17 needs only 2 + 272 B). */
#define PFD_NEWPFOR_BLOCK_MAX_BYTES                                            \
    (PFD_NEWPFOR_HEADER_BYTES + 4 * 2 * PFD_NEWPFOR_MAX_EXCEPTIONS +           \
     16 * 16)
#define PFD_OPTPFOR_MAX_EXCEPTIONS  127     /* 7-bit header field      */
#define PFD_OPTPFOR_BLOCK_MAX_BYTES (PFD_NEWPFOR_HEADER_BYTES + 16 * 17)
#define PFD_SIMPLE8B_WORD_BYTES     8

/* Worst-case payload bytes for n samples (any delta mode). */
size_t pfordelta_newpfor_max_bytes(size_t n);
size_t pfordelta_optpfor_max_bytes(size_t n);
size_t pfordelta_simple8b_rle_max_bytes(size_t n);

/*
 * Encode samples[0..n) with delta_mode PFD_DELTA_WRAP16 or PFD_DELTA_FULL17.
 * Returns payload bytes written, 0 on error (n == 0, bad mode, cap too
 * small). cap >= *_max_bytes(n) always suffices.
 */
size_t pfordelta_newpfor_encode(const int16_t *samples, size_t n,
                                int delta_mode, uint8_t *out, size_t cap);
size_t pfordelta_optpfor_encode(const int16_t *samples, size_t n,
                                int delta_mode, uint8_t *out, size_t cap);
size_t pfordelta_simple8b_rle_encode(const int16_t *samples, size_t n,
                                     int delta_mode, uint8_t *out,
                                     size_t cap);

/* Decode exactly n samples from a len-byte payload, which must be consumed
 * exactly. Returns 0 on success, -1 on malformed input. The payload does not
 * record n, so a wrong n is only caught when it breaks the layout (e.g. a
 * Simple8b word with zero filler can absorb one extra zero code). */
int pfordelta_newpfor_decode(const uint8_t *in, size_t len, int16_t *samples,
                             size_t n);
int pfordelta_optpfor_decode(const uint8_t *in, size_t len, int16_t *samples,
                             size_t n);
int pfordelta_simple8b_rle_decode(const uint8_t *in, size_t len,
                                  int16_t *samples, size_t n);

#endif /* PFORDELTA_H */
