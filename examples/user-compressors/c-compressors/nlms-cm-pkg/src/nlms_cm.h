/*
 * nlms_cm.h — NLMS-CM: NLMS prediction + context mixing + binary range coder.
 *
 * Lossless (epsilon = 0) or hard-bound lossy codec for int16 lanes. Per
 * sample and lane:
 *
 *   y[t]  = round(x[t] / q), q = 2*epsilon + 1   (ties away from zero;
 *           |x - y*q| <= epsilon, the open-loop grid of dpcm_range)
 *   p[t]  = prediction of y[t] from the past indices of the same lane:
 *           NLMS_CM_PRED_DELTA  p = y[t-1]
 *           NLMS_CM_PRED_NLMS   p = round(P1) + round(P2), a two-stage integer
 *                           NLMS cascade: P1 = 16 taps on y (mu = 1/2), P2 =
 *                           4 taps on y - round(P1) (mu = 1); Q20 weights,
 *                           normalised update every 64 samples
 *           p is clamped to the representable index range
 *   r[t]  = y[t] - p[t], coded with binary decisions
 *           zero | sign | exponent e = bit_length(|r|) in unary (14
 *           positions, then 4 raw bits of e - 15) | top two mantissa bits
 *           modelled | remaining mantissa bits raw
 *
 * Every modelled decision mixes two adaptive bit models in the logistic
 * domain: context A = (bucket of 2|r1|+|r2|+|r3|, sign of r1) (60 contexts),
 * context B = half-octave bucket of the last eight |r| (40 contexts); the
 * mixer weight set is chosen by bit_length(|r1|) (8 sets). Bit models are
 * 16-bit words (12-bit probability + 4-bit count, adaptation rate 1/2,
 * 1/3, ... down to 1/64). The mixed probability drives an LZMA-style binary
 * range coder with 16-bit probabilities. Integer-only and deterministic; the
 * logistic tables are constants (lib/src/nlms_cm_tables.c).
 *
 * Chunk wire format (little-endian):
 *   u32 total_bytes | u32 n | u8 lanes | u8 flags | u16 epsilon | range bytes
 *   flags: bit 0 = predictor (1 = NLMS), bits 4..7 = NLMS_CM_VERSION.
 * Samples are interleaved per time step (lane 0..lanes-1 at t, then t+1).
 * The predictors, residual histories and the model carry across chunks, so
 * a stream is one continuous adaptive model and must be decoded in order
 * from its first chunk (as dpcm_range).
 *
 * Memory: the caller provides the model (NLMS_CM_MODEL_BYTES, 4-byte aligned).
 * Several streams may share one model buffer (e.g. the accelerometer and
 * gyroscope triads); all of them must then be encoded and decoded in the
 * same interleaved order. The state holds the per-lane predictors
 * (sizeof(nlms_cm_state)). No heap, no stdio, no static mutable state; ~0.3 KiB
 * of stack.
 */
#ifndef NLMS_CM_H
#define NLMS_CM_H

#include <stddef.h>
#include <stdint.h>

#define NLMS_CM_MAX_LANES           6
#define NLMS_CM_PRED_DELTA          0
#define NLMS_CM_PRED_NLMS           1
#define NLMS_CM_VERSION             1
#define NLMS_CM_CHUNK_HEADER_BYTES  12
#define NLMS_CM_MAX_EPSILON         32767

#define NLMS_CM_NLMS1_TAPS          16
#define NLMS_CM_NLMS2_TAPS          4
#define NLMS_CM_HISTORY             8
#define NLMS_CM_SLOTS               18
#define NLMS_CM_CONTEXTS_A          60
#define NLMS_CM_CONTEXTS_B          40
#define NLMS_CM_WEIGHT_SETS         8
#define NLMS_CM_MODEL_BYTES                                                        \
    ((NLMS_CM_CONTEXTS_A + NLMS_CM_CONTEXTS_B) * NLMS_CM_SLOTS * 2 +                       \
     NLMS_CM_SLOTS * NLMS_CM_WEIGHT_SETS * 3 * 4)

/* Per-lane predictor state. The histories are rings so a new sample costs no
 * shifting: h1 is stored twice (h1[i] == h1[i + 16]) so the window
 * h1[pos1 .. pos1 + 15] is contiguous, newest first. energy1/energy2 hold the
 * running sum of squares of the current windows and rsum the sum of the eight
 * residual magnitudes. The layout is internal; only sizeof(nlms_cm_state) is
 * part of the API. */
typedef struct {
    int32_t w1[NLMS_CM_NLMS1_TAPS];          /* Q20 weights                     */
    int32_t h1[2 * NLMS_CM_NLMS1_TAPS];      /* doubled ring, newest at pos1    */
    int64_t s1[NLMS_CM_NLMS1_TAPS], norm1, energy1;
    int32_t w2[NLMS_CM_NLMS2_TAPS], h2[NLMS_CM_NLMS2_TAPS];
    int64_t s2[NLMS_CM_NLMS2_TAPS], norm2, energy2;
    int32_t block_count;
    int32_t pos1;                        /* ring position of h1[0]          */
    int32_t previous;                    /* y[t-1]                          */
    int32_t residual[NLMS_CM_HISTORY];       /* ring, r[t-1] at rpos            */
    int32_t rpos;
    uint32_t rsum;                       /* sum of |residual|               */
} nlms_cm_lane;

typedef struct {
    int32_t epsilon;
    int32_t quantiser_step;              /* q = 2*epsilon + 1               */
    int32_t index_min, index_max;        /* y range for int16 input         */
    int lane_count;                      /* 1..NLMS_CM_MAX_LANES                */
    int predictor;                       /* NLMS_CM_PRED_DELTA / NLMS_CM_PRED_NLMS  */
    void *model;                         /* NLMS_CM_MODEL_BYTES, caller-owned   */
    nlms_cm_lane lane[NLMS_CM_MAX_LANES];
} nlms_cm_state;

typedef struct {
    uint64_t max_error;
    uint64_t sum_error;
    uint64_t samples;
} nlms_cm_stats;

/* Initialise a stream and reset its model buffer. Returns 0, or -1 for a bad
 * argument (epsilon outside 0..NLMS_CM_MAX_EPSILON, lanes outside 1..6, unknown
 * predictor, NULL or misaligned model). */
int nlms_cm_init(nlms_cm_state *state, int epsilon, int lanes, int predictor,
             void *model);

/* Worst-case payload bytes of one chunk (n samples on each lane). */
size_t nlms_cm_max_chunk_bytes(size_t n, int lanes);

/* Encode n samples of every lane (in[a] points to n int16). Returns payload
 * bytes, 0 on error (n == 0, cap too small). */
size_t nlms_cm_encode_chunk(nlms_cm_state *state, const int16_t *const *in, size_t n,
                        uint8_t *out, size_t cap, nlms_cm_stats *stats);

/* Decode one chunk; out[a] receives n reconstructed samples (y * q).
 * Returns 0, or -1 on malformed input (header mismatch, truncation, an
 * index outside the int16 range). Like dpcm_range, the range-coded payload
 * has no checksum: a corrupted payload can decode to wrong samples. */
int nlms_cm_decode_chunk(nlms_cm_state *state, const uint8_t *in, size_t len,
                     int32_t *const *out, size_t n);

#endif /* NLMS_CM_H */
