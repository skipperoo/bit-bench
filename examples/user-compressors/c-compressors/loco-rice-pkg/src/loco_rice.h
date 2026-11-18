/*
 * loco_rice.h — LOCO-Rice: a 1-D adaptation of JPEG-LS's LOCO-I model with
 * an adaptive Golomb-Rice code, for int16 sensor streams. Lossless (eps = 0)
 * or near-lossless with the hard bound |x - y| <= eps on every sample.
 *
 * Model, per sample (y = reconstructed history, d1 = y1 - y2, d2 = y2 - y3):
 *   context   c = 2 * min(11, bit_length((|d1| + |d2|) / (2eps+1)))
 *                 + (d1 and d2 have the same sign)              (24 contexts)
 *   prediction P = clamp16(y1 + s * C[c]), s = -1 if d1 < 0 else +1;
 *              C[c] is a per-context bias correction (JPEG-LS style), so it
 *              learns how far a local trend tends to continue;
 *   residual  e = s * (x - P), quantised q = sign(e) * ((|e| + eps) / (2eps+1));
 *              reconstruction y = clamp16(P + s * q * (2eps+1));
 *   code      m = zig-zag(q); Golomb-Rice with k = min k : N[c] << k >= A[c];
 *              unary(m >> k) as zeros then a 1, then k low bits; when
 *              m >> k >= 24: 24 zeros, a 1, then m in 18 bits (escape);
 *   update    A += |q|, B += q * (2eps+1), C/B bias step as JPEG-LS, N++,
 *              halve A, B, N at N = 64.
 * Divisions by the step use an exact reciprocal multiply (the dividend is
 * below 2^17 and the step at most 511).
 *
 * Chunk format:
 *   u16 n (LE) | u8 eps | u8 flags | Rice bitstream, MSB first, zero padded
 *   flags bit 0: the chunk continues the state of the previous chunk of the
 *   same stream (contexts and the last three samples); clear on the first
 *   chunk and after loco_rice_reset(). Other bits must be zero.
 *
 * Streams: the encoder and the decoder each keep a loco_rice_state; chunks
 * must be decoded in order. Call loco_rice_reset() on both sides before a
 * chunk to make it decodable on its own (1-6 % larger output on the
 * benchmark data).
 *
 * Memory: the state is 308 bytes; no heap, no tables, a few words of stack.
 */
#ifndef LOCO_RICE_H
#define LOCO_RICE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LOCO_RICE_HEADER_BYTES  4
#define LOCO_RICE_MAX_EPS       255
#define LOCO_RICE_MAX_CHUNK     65535u
#define LOCO_RICE_CONTEXTS      24

typedef struct {
    int32_t  A[LOCO_RICE_CONTEXTS];  /* sum of |q|                          */
    int32_t  B[LOCO_RICE_CONTEXTS];  /* bias accumulator (sample units)     */
    int16_t  C[LOCO_RICE_CONTEXTS];  /* bias correction (sample units)      */
    int16_t  N[LOCO_RICE_CONTEXTS];  /* occurrence count                    */
    int32_t  y1, y2, y3;             /* last reconstructed samples          */
    uint32_t recip;                  /* ceil(2^32 / step), step = 2eps + 1  */
    int16_t  eps;
    uint8_t  started;                /* a chunk has used this state         */
    uint8_t  reserved;
} loco_rice_state;

/* Initialise a stream. Returns 0, or -1 for eps outside 0..255 or a NULL
 * state. */
int loco_rice_init(loco_rice_state *s, int eps);

/* Make the next chunk independent of the previous ones (both sides). */
void loco_rice_reset(loco_rice_state *s);

/* Worst-case payload of an n-sample chunk (43 bits per sample + header). */
size_t loco_rice_max_chunk_bytes(size_t n);

/* Encode n (1..65535) samples. Returns the payload size, or 0 on error
 * (bad argument or cap too small; the state is then unusable for the
 * stream and must be re-initialised). */
size_t loco_rice_encode_chunk(loco_rice_state *s, const int16_t *x, size_t n,
                              uint8_t *out, size_t cap);

/* Decode one chunk of n samples into y. Returns 0, or -1 on malformed
 * input (header mismatch, a continued chunk without a previous one,
 * truncation, trailing bytes or non-zero padding). Like the range coders
 * the payload has no checksum: corruption that stays well-formed decodes
 * to wrong samples. */
int loco_rice_decode_chunk(loco_rice_state *s, const uint8_t *in, size_t len,
                           int16_t *y, size_t n);

#ifdef __cplusplus
}
#endif

#endif /* LOCO_RICE_H */
