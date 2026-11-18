/*
 * dpcm_range.h — hard-bound DPCM + binary range coder.
 *
 * Hard per-sample bound: q = 2*epsilon + 1. epsilon = 0 (q = 1) is the
 * lossless mode: the quantiser is the identity and is skipped, the index
 * delta k is the plain sample delta (|k| <= 65535 for int16, coded through
 * the exponent escape), and the bytes are those of the generic q = 1 path.
 * The encoder
 * runs the reconstruction loop
 *
 *   xhat[0] = anchor * q                       (anchor stored in the chunk)
 *   r[t]    = x[t] - xhat[t-1]
 *   k[t]    = nearest multiple of q to r[t]    (ties away from zero)
 *   xhat[t] = xhat[t-1] + k[t] * q
 *
 * so |x[t] - xhat[t]| <= (q-1)/2 = epsilon for every sample. With a grid
 * anchor and odd q this is exactly the open-loop uniform quantiser of x[t]
 * expressed as an index-delta stream (order-1 DPCM is a no-op, see
 * docs/research.md §11.9).
 *
 * The index-delta k is entropy coded with a binary range coder (LZMA-style
 * carry handling, 12-bit probabilities):
 *
 *   zero flag | sign | exponent unary (e = bit_length(|k|), 12 positions
 *   + 4-bit escape) | top two mantissa bits modeled | remaining mantissa
 *   bits direct (p = 1/2)
 *
 * Contexts: (previous exponent 0..16) x (previous sign 3) x (4-level
 * selector) = 204. The selector is min(3, max(previous-previous exponent of
 * this lane, max previous exponent of the other two lanes in the same triad)).
 * One context table is shared by all lanes, which the Phase-2 study showed
 * costs ~0.002 b/s.
 *
 * Each context is 16 bytes (zero, sign, 12 exponent, 2 mantissa), so the
 * model is 3264 B. The caller provides that probability buffer.
 * Probabilities use two shift-only adaptation rates (fast for zero/exponent,
 * slower for sign/mantissa); there is no division anywhere in the coder.
 *
 * Chunks are independently decodable (the range coder is flushed per chunk)
 * but the context state and the previous exponents/signs carry across
 * chunks, so the stream is one continuous adaptive model.
 */
#ifndef DPCM_RANGE_H
#define DPCM_RANGE_H

#include <stddef.h>
#include <stdint.h>

#define DPCM_RANGE_MAX_LANES            6
#define DPCM_RANGE_CONTEXTS             204
#define DPCM_RANGE_CONTEXT_BYTES        16
#define DPCM_RANGE_MAX_EXPONENT         12
#define DPCM_RANGE_CHUNK_HEADER_BYTES   12  /* len u32, n u32, lanes u16,
                                               flags u16 + per-lane anchors */
#define DPCM_RANGE_STREAM_HEADER_BYTES  16  /* "DPR1", version, contexts,
                                               lanes, chunk_samples, total   */

typedef struct {
    int32_t quantiser_step;             /* q = 2*epsilon + 1                 */
    int32_t epsilon;
    int lane_count;                     /* 1..6                              */
    int32_t previous_exponent[DPCM_RANGE_MAX_LANES];
    int32_t exponent_before_previous[DPCM_RANGE_MAX_LANES];
    int8_t  previous_sign[DPCM_RANGE_MAX_LANES];  /* -1, 0, +1              */
    uint8_t *probabilities;             /* DPCM_RANGE_CONTEXTS *
                                           DPCM_RANGE_CONTEXT_BYTES bytes    */
} dpcm_range_state;

typedef struct {
    uint64_t max_error;
    uint64_t sum_error;
    uint64_t samples;
} dpcm_range_stats;

/* `probability_buffer` must hold DPCM_RANGE_CONTEXTS * CONTEXT_BYTES bytes
 * and stay alive for the whole stream. */
void dpcm_range_init(dpcm_range_state *state, int epsilon, int lanes,
                     uint8_t *probability_buffer);

/* Encode one chunk of n samples on each of `lanes` lanes. `in[a]` points to
 * n int16 samples. Verifies the hard bound while encoding and returns the
 * payload length, or 0 on error (including a bound violation). */
size_t dpcm_range_encode_chunk(dpcm_range_state *state,
                               const int16_t *const *in, size_t n,
                               uint8_t *out, size_t cap,
                               dpcm_range_stats *stats);

/* Decode one chunk. `out[a]` receives n reconstructed int32 samples. */
int dpcm_range_decode_chunk(dpcm_range_state *state, const uint8_t *in,
                            size_t len, int32_t *const *out, size_t n);

size_t dpcm_range_max_chunk_bytes(size_t n, int lanes);

/* Whole-stream helpers (one lane). */
size_t dpcm_range_pack(const int16_t *samples, size_t n, int epsilon,
                       uint8_t *out, size_t cap, dpcm_range_stats *stats);
int dpcm_range_unpack(const uint8_t *in, size_t len, int32_t *samples);

#endif /* DPCM_RANGE_H */
