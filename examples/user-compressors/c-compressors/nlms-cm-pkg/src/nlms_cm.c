/*
 * nlms_cm.c — see nlms_cm.h. Integer-only, no heap, no stdio.
 *
 * Speed-oriented implementation (Cortex-M4 target). The coded bitstream is
 * bit-identical to the reference implementation; only the arithmetic is
 * arranged differently:
 *   - encoder and decoder have separate, fully inlined bit paths;
 *   - mixer weight updates run in 32-bit (the products fit in 24 bits);
 *   - the mixer output is saturated once to the squash domain (SSAT #12);
 *   - bit lengths use CLZ instead of loops;
 *   - histories are rings (no memmove); window energy and the residual
 *     magnitude sum are maintained incrementally;
 *   - the NLMS error term uses a 32x32->64 MAC (SMLAL) whenever it fits in
 *     32 bits, and the block update needs one 64-bit division per tap.
 */
#include "nlms_cm.h"

#include <stdint.h>
#include <string.h>

#if defined(__ARM_FEATURE_SAT) && __ARM_FEATURE_SAT
#include <arm_acle.h>
#endif

extern const int16_t nlms_cm_stretch_table[4096];
extern const int16_t nlms_cm_squash_table[4096];

#define NLMS_Q            20
#define NLMS_BLOCK        64
#define NLMS_WMAX         (INT32_C(1) << 24)  /* |w| <= 16.0 in Q20          */
#define RATE_LIMIT        6                   /* final adaptation 1/64       */
#define MIX_SHIFT         10                  /* mixer learning rate 2^-10   */
#define MIX_W0            22938               /* 0.35 in Q16                 */
#define MIX_WMAX          (INT32_C(1) << 24)
#define P_MIN             64
#define P_MAX             65472
#define EXP_UNARY         14
#define MAX_MAGNITUDE_EXP 16                  /* |r| <= 65535                */

#if defined(__GNUC__) || defined(__clang__)
#define NLMS_CM_INLINE   static inline __attribute__((always_inline))
#define NLMS_CM_NOINLINE static __attribute__((noinline))
#else
#define NLMS_CM_INLINE   static inline
#define NLMS_CM_NOINLINE static
#endif

/* Keep the 64-bit accumulator loops rolled by 4: fully unrolled 16-tap
 * int64 loops spill most of the Cortex-M4 register file. */
#if defined(__GNUC__) && !defined(__clang__)
#define NLMS_CM_UNROLL4 _Pragma("GCC unroll 4")
#else
#define NLMS_CM_UNROLL4
#endif

/* ---------------- integer helpers ---------------- */

/* floor(a / 2^s). GCC and Clang define >> on negative values as an
 * arithmetic shift (= floor); other compilers get the portable form. */
#if defined(__GNUC__) || defined(__clang__)
NLMS_CM_INLINE int32_t asr32(int32_t a, int s) { return a >> s; }
NLMS_CM_INLINE int64_t asr64(int64_t a, int s) { return a >> s; }
#else
NLMS_CM_INLINE int32_t asr32(int32_t a, int s) {
    return a >= 0 ? a >> s : -(int32_t)((((uint32_t)(-(a + 1))) >> s) + 1u);
}
NLMS_CM_INLINE int64_t asr64(int64_t a, int s) {
    return a >= 0 ? a >> s : -(int64_t)((((uint64_t)(-(a + 1))) >> s) + 1u);
}
#endif

/* round(a / 2^s), halves up */
NLMS_CM_INLINE int64_t round_shift(int64_t a, int s) {
    return asr64(a + (INT64_C(1) << (s - 1)), s);
}

NLMS_CM_INLINE int bit_length32(uint32_t v) {
#if defined(__GNUC__) || defined(__clang__)
    return v ? 32 - __builtin_clz(v) : 0;
#else
    int n = 0;
    while (v) { n++; v >>= 1; }
    return n;
#endif
}

NLMS_CM_INLINE int32_t clamp32(int64_t v, int32_t lo, int32_t hi) {
    return v < lo ? lo : (v > hi ? hi : (int32_t)v);
}

/* clamp to [-2048, 2047] */
NLMS_CM_INLINE int32_t sat12(int32_t x) {
#if defined(__ARM_FEATURE_SAT) && __ARM_FEATURE_SAT
    return __ssat(x, 12);
#else
    return x < -2048 ? -2048 : (x > 2047 ? 2047 : x);
#endif
}

NLMS_CM_INLINE uint32_t magnitude(int32_t v) {
    return v < 0 ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
}

/* round(x / q), ties away from zero */
NLMS_CM_INLINE int32_t nearest_index(int32_t x, int32_t q) {
    if (q == 1)
        return x;
    int32_t half = q / 2;
    return x >= 0 ? (x + half) / q : -((-x + half) / q);
}

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* ---------------- NLMS ---------------- */

NLMS_CM_INLINE int64_t dot16(const int32_t *w, const int32_t *h) {
    int64_t a = 0;
    NLMS_CM_UNROLL4
    for (int j = 0; j < NLMS_CM_NLMS1_TAPS; j++)
        a += (int64_t)w[j] * h[j];                 /* SMLAL */
    return a;
}

NLMS_CM_INLINE int64_t dot4(const int32_t *w, const int32_t *h) {
    return (int64_t)w[0] * h[0] + (int64_t)w[1] * h[1] +
           (int64_t)w[2] * h[2] + (int64_t)w[3] * h[3];
}

/* s[j] += e10 * h[j] when e10 does not fit in 32 bits (rare: a prediction
 * error beyond +-2^21 indices). */
NLMS_CM_NOINLINE void accumulate_wide(int64_t *s, const int32_t *h, int taps,
                                  int64_t e10) {
    for (int j = 0; j < taps; j++)
        s[j] += e10 * h[j];
}

/* s[j] += e10 * h[j] for one window. e10 = floor(e_Q20 / 2^10). */
NLMS_CM_INLINE void accumulate(int64_t *s, const int32_t *h, int taps, int64_t e10) {
    if (e10 == (int64_t)(int32_t)e10) {
        const int32_t e = (int32_t)e10;
        NLMS_CM_UNROLL4
        for (int j = 0; j < taps; j++)
            s[j] += (int64_t)e * h[j];              /* LDRD, SMLAL, STRD */
    } else {
        accumulate_wide(s, h, taps, e10);
    }
}

/* w[j] += floor((trunc(s[j] * 2^10 / norm)) / 2^mu_shift), with the
 * reference's saturation of the quotient at 2^30 (inc = +-2^40). */
static void nlms_update(int32_t *w, int64_t *s, int64_t *norm, int taps,
                        int mu_shift) {
    const int64_t norm_v = *norm;
    if (norm_v > 0) {
        const int64_t lim = INT64_C(1) << 53;
        const int64_t qmax = ((INT64_C(1) << 30) + 1) * 1024;
        for (int j = 0; j < taps; j++) {
            int64_t sj = s[j], inc;
            if (sj < lim && sj > -lim) {
                /* trunc(s*1024/norm) == q*1024 + trunc(r*1024/norm) */
                int64_t v = (sj * 1024) / norm_v;
                if (v >= qmax)
                    inc = INT64_C(1) << 40;
                else if (v <= -qmax)
                    inc = -(INT64_C(1) << 40);
                else
                    inc = v;
            } else {
                int64_t q = sj / norm_v, r = sj % norm_v;
                if (q > (INT64_C(1) << 30))
                    inc = INT64_C(1) << 40;
                else if (q < -(INT64_C(1) << 30))
                    inc = -(INT64_C(1) << 40);
                else
                    inc = q * 1024 + (r * 1024) / norm_v;
            }
            if (mu_shift)
                inc = asr64(inc, mu_shift);
            w[j] = clamp32((int64_t)w[j] + inc, -NLMS_WMAX, NLMS_WMAX);
        }
    }
    memset(s, 0, (size_t)taps * sizeof *s);
    *norm = 0;
}

typedef struct {
    int64_t p1_q20, p2_q20;
    int32_t p1, prediction;
} prediction_t;

NLMS_CM_INLINE void predict(const nlms_cm_state *state, const nlms_cm_lane *lane,
                        prediction_t *p) {
    if (state->predictor == NLMS_CM_PRED_DELTA) {
        p->p1_q20 = p->p2_q20 = 0;
        p->p1 = p->prediction = lane->previous;
        return;
    }
    p->p1_q20 = dot16(lane->w1, lane->h1 + lane->pos1);
    p->p1 = clamp32(round_shift(p->p1_q20, NLMS_Q), state->index_min,
                    state->index_max);
    p->p2_q20 = dot4(lane->w2, lane->h2);
    int64_t p2 = round_shift(p->p2_q20, NLMS_Q);
    p->prediction = clamp32((int64_t)p->p1 + clamp32(p2, -65536, 65536),
                            state->index_min, state->index_max);
}

NLMS_CM_NOINLINE void predictor_update(const nlms_cm_state *state, nlms_cm_lane *lane,
                                   const prediction_t *p, int32_t y) {
    lane->previous = y;
    if (state->predictor == NLMS_CM_PRED_DELTA)
        return;

    /* stage 1: 16 taps on y */
    int32_t *h1 = lane->h1 + lane->pos1;
    int64_t e1 = asr64((int64_t)y * (INT64_C(1) << NLMS_Q) - p->p1_q20, 10);
    accumulate(lane->s1, h1, NLMS_CM_NLMS1_TAPS, e1);
    lane->norm1 += lane->energy1;
    int32_t old1 = h1[NLMS_CM_NLMS1_TAPS - 1];
    lane->energy1 += (int64_t)y * y - (int64_t)old1 * old1;
    int pos = (lane->pos1 - 1) & (NLMS_CM_NLMS1_TAPS - 1);
    lane->h1[pos] = y;
    lane->h1[pos + NLMS_CM_NLMS1_TAPS] = y;
    lane->pos1 = pos;

    /* stage 2: 4 taps on y - p1 */
    int32_t t2 = y - p->p1;
    int32_t *h2 = lane->h2;
    int64_t e2 = asr64((int64_t)t2 * (INT64_C(1) << NLMS_Q) - p->p2_q20, 10);
    accumulate(lane->s2, h2, NLMS_CM_NLMS2_TAPS, e2);
    lane->norm2 += lane->energy2;
    lane->energy2 += (int64_t)t2 * t2 - (int64_t)h2[3] * h2[3];
    h2[3] = h2[2]; h2[2] = h2[1]; h2[1] = h2[0]; h2[0] = t2;

    if (++lane->block_count == NLMS_BLOCK) {
        nlms_update(lane->w1, lane->s1, &lane->norm1, NLMS_CM_NLMS1_TAPS, 1);
        nlms_update(lane->w2, lane->s2, &lane->norm2, NLMS_CM_NLMS2_TAPS, 0);
        lane->block_count = 0;
    }
}

/* ---------------- model (caller workspace) ---------------- */

typedef struct {
    int32_t weights[NLMS_CM_SLOTS][NLMS_CM_WEIGHT_SETS][3];
    uint16_t a[NLMS_CM_CONTEXTS_A][NLMS_CM_SLOTS];
    uint16_t b[NLMS_CM_CONTEXTS_B][NLMS_CM_SLOTS];
} nlms_cm_model;

typedef char nlms_cm_model_size_check[(sizeof(nlms_cm_model) == NLMS_CM_MODEL_BYTES) ? 1 : -1];

static void model_reset(nlms_cm_model *m) {
    for (int s = 0; s < NLMS_CM_SLOTS; s++)
        for (int g = 0; g < NLMS_CM_WEIGHT_SETS; g++) {
            m->weights[s][g][0] = MIX_W0;
            m->weights[s][g][1] = MIX_W0;
            m->weights[s][g][2] = 0;
        }
    for (int c = 0; c < NLMS_CM_CONTEXTS_A; c++)
        for (int s = 0; s < NLMS_CM_SLOTS; s++)
            m->a[c][s] = 32768;
    for (int c = 0; c < NLMS_CM_CONTEXTS_B; c++)
        for (int s = 0; s < NLMS_CM_SLOTS; s++)
            m->b[c][s] = 32768;
}

/* Bit model: bits 15..4 = P(1) in 1/4096 (as a Q16 value with the low four
 * bits cleared), bits 3..0 = number of updates seen (saturating at 15).
 * p stays a multiple of 16 in [P_MIN, P_MAX], so a 1 can only overshoot
 * P_MAX and a 0 can only undershoot P_MIN: one clamp per branch. */
static const uint8_t bit_rate[16] = { 1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6 };

NLMS_CM_INLINE void bit_update1(uint16_t *word) {
    uint32_t wv = *word, n = wv & 15u;
    int32_t p = (int32_t)(wv & 0xFFF0u);
    p += (65536 - p) >> bit_rate[n];
    if (p > P_MAX) p = P_MAX;
    *word = (uint16_t)(((uint32_t)p & 0xFFF0u) | (n + (n < 15u)));
}

NLMS_CM_INLINE void bit_update0(uint16_t *word) {
    uint32_t wv = *word, n = wv & 15u;
    int32_t p = (int32_t)(wv & 0xFFF0u);
    p -= p >> bit_rate[n];
    if (p < P_MIN) p = P_MIN;
    *word = (uint16_t)(((uint32_t)p & 0xFFF0u) | (n + (n < 15u)));
}

NLMS_CM_INLINE void bit_update2(uint16_t *ma, uint16_t *mb, int bit) {
    if (bit) { bit_update1(ma); bit_update1(mb); }
    else     { bit_update0(ma); bit_update0(mb); }
}

/* Context of one residual: model rows and the mixer weight set. */
typedef struct {
    uint16_t *a, *b;            /* m->a[ctx_a], m->b[ctx_b]           */
    int32_t *w;                 /* m->weights[0][g]; slot stride 24   */
} context_t;

#define W_SLOT_STRIDE (NLMS_CM_WEIGHT_SETS * 3)

NLMS_CM_INLINE context_t make_context(nlms_cm_model *m, const nlms_cm_lane *lane) {
    context_t c;
    int rp = lane->rpos;
    int32_t r0 = lane->residual[rp];
    uint32_t a1 = magnitude(r0);
    uint32_t a2 = magnitude(lane->residual[(rp + 1) & (NLMS_CM_HISTORY - 1)]);
    uint32_t a3 = magnitude(lane->residual[(rp + 2) & (NLMS_CM_HISTORY - 1)]);
    int sign = (r0 > 0) - (r0 < 0) + 1;
    int bucket = bit_length32(2u * a1 + a2 + a3);
    if (bucket > 19) bucket = 19;
    uint32_t sum = lane->rsum;
    int e = bit_length32(sum);
    int half = e > 1 ? (int)((sum >> (e - 2)) & 1u) : 0;
    int cb = 2 * e + half;
    if (cb >= NLMS_CM_CONTEXTS_B) cb = NLMS_CM_CONTEXTS_B - 1;
    int g = bit_length32(a1);
    if (g >= NLMS_CM_WEIGHT_SETS) g = NLMS_CM_WEIGHT_SETS - 1;
    c.a = m->a[bucket * 3 + sign];
    c.b = m->b[cb];
    c.w = &m->weights[0][g][0];
    return c;
}

NLMS_CM_INLINE void push_residual(nlms_cm_lane *lane, int32_t value) {
    int rp = (lane->rpos - 1) & (NLMS_CM_HISTORY - 1);   /* oldest slot */
    lane->rsum += magnitude(value) - magnitude(lane->residual[rp]);
    lane->residual[rp] = value;
    lane->rpos = rp;
}

/* Mixer: P(1) in 1/4096 from the two models' stretched probabilities. The
 * reference clamps the Q16 dot to +-4096 and squash() then to [-2048, 2047];
 * the composition is one saturation. */
NLMS_CM_INLINE int mix(const int32_t *w, int32_t sa, int32_t sb) {
    int64_t dot = (int64_t)w[0] * sa + (int64_t)w[1] * sb + (int64_t)w[2] * 256;
    return nlms_cm_squash_table[sat12((int32_t)asr64(dot, 16)) + 2048];
}

/* clamp to [-MIX_WMAX, MIX_WMAX]; |v| < 2^25 here, the limits are rare */
NLMS_CM_INLINE int32_t clamp_w(int32_t v) {
    if ((uint32_t)v + (uint32_t)MIX_WMAX > 2u * (uint32_t)MIX_WMAX)
        v = v < 0 ? -MIX_WMAX : MIX_WMAX;
    return v;
}

/* |sa| <= 2047 and |err| <= 4096, so the products fit in 24 bits. */
NLMS_CM_INLINE void mix_update(int32_t *w, int32_t sa, int32_t sb, int32_t err) {
    w[0] = clamp_w(w[0] + asr32(sa * err, MIX_SHIFT));
    w[1] = clamp_w(w[1] + asr32(sb * err, MIX_SHIFT));
    w[2] = clamp_w(w[2] + asr32(err, MIX_SHIFT - 8));
}

/* ---------------- range coder (LZMA carry scheme, 16-bit probabilities) - */

typedef struct {
    uint64_t low;
    uint32_t range;
    uint8_t cache;
    uint64_t cache_size;
    uint8_t *out;
    size_t cap, len;
    int ok;
} range_encoder;

static void encoder_shift_low(range_encoder *e) {
    if ((uint32_t)e->low < 0xFF000000u || (e->low >> 32) != 0) {
        uint8_t carry = (uint8_t)(e->low >> 32);
        uint8_t temp = e->cache;
        do {
            if (e->len < e->cap) e->out[e->len] = (uint8_t)(temp + carry);
            else e->ok = 0;
            e->len++;
            temp = 0xFF;
        } while (--e->cache_size != 0);
        e->cache = (uint8_t)((uint32_t)e->low >> 24);
    }
    e->cache_size++;
    e->low = (uint64_t)((uint32_t)e->low << 8);
}

NLMS_CM_INLINE void encoder_normalize(range_encoder *e) {
    while (e->range < (1u << 24)) {
        e->range <<= 8;
        encoder_shift_low(e);
    }
}

/* p1 = P(bit = 1) in 1/4096, 1..4095 */
NLMS_CM_INLINE void encoder_bit(range_encoder *e, int p1, int bit) {
    uint32_t bound = (e->range >> 16) * ((uint32_t)(4096 - p1) << 4);
    if (!bit) {
        e->range = bound;
    } else {
        e->low += bound;
        e->range -= bound;
    }
    encoder_normalize(e);
}

NLMS_CM_INLINE void encoder_direct(range_encoder *e, int bit) {
    e->range >>= 1;
    if (bit) e->low += e->range;
    encoder_normalize(e);
}

typedef struct {
    uint32_t code, range;
    const uint8_t *in;
    size_t len, pos;
    int fail;
} range_decoder;

NLMS_CM_INLINE uint8_t decoder_get(range_decoder *d) {
    if (d->pos >= d->len) { d->fail = 1; return 0; }
    return d->in[d->pos++];
}

NLMS_CM_INLINE void decoder_normalize(range_decoder *d) {
    while (d->range < (1u << 24)) {
        d->range <<= 8;
        d->code = (d->code << 8) | decoder_get(d);
    }
}

NLMS_CM_INLINE int decoder_bit(range_decoder *d, int p1) {
    uint32_t bound = (d->range >> 16) * ((uint32_t)(4096 - p1) << 4);
    int bit;
    if (d->code < bound) {
        d->range = bound;
        bit = 0;
    } else {
        d->code -= bound;
        d->range -= bound;
        bit = 1;
    }
    decoder_normalize(d);
    return bit;
}

NLMS_CM_INLINE int decoder_direct(range_decoder *d) {
    d->range >>= 1;
    int bit = d->code >= d->range;
    if (bit) d->code -= d->range;
    decoder_normalize(d);
    return bit;
}

/* ---------------- modelled bits ---------------- */

NLMS_CM_INLINE void enc_bit(range_encoder *e, const context_t *ctx, int slot,
                        int bit) {
    uint16_t *ma = ctx->a + slot, *mb = ctx->b + slot;
    int32_t *w = ctx->w + slot * W_SLOT_STRIDE;
    int32_t sa = nlms_cm_stretch_table[*ma >> 4], sb = nlms_cm_stretch_table[*mb >> 4];
    int p1 = mix(w, sa, sb);
    encoder_bit(e, p1, bit);
    mix_update(w, sa, sb, ((int32_t)bit << 12) - p1);
    bit_update2(ma, mb, bit);
}

NLMS_CM_INLINE int dec_bit(range_decoder *d, const context_t *ctx, int slot) {
    uint16_t *ma = ctx->a + slot, *mb = ctx->b + slot;
    int32_t *w = ctx->w + slot * W_SLOT_STRIDE;
    int32_t sa = nlms_cm_stretch_table[*ma >> 4], sb = nlms_cm_stretch_table[*mb >> 4];
    int p1 = mix(w, sa, sb);
    int bit = decoder_bit(d, p1);
    mix_update(w, sa, sb, ((int32_t)bit << 12) - p1);
    bit_update2(ma, mb, bit);
    return bit;
}

/* ---------------- residual coding ---------------- */

/* zero | sign | unary exponent (14 modelled, then 4 raw bits of e - 15) |
 * two modelled mantissa bits | raw mantissa bits */
static void encode_residual(range_encoder *e, nlms_cm_model *m, nlms_cm_lane *lane,
                            int32_t r) {
    context_t ctx = make_context(m, lane);
    uint32_t mag = magnitude(r);
    if (mag == 0) {
        enc_bit(e, &ctx, 0, 0);
        push_residual(lane, 0);
        return;
    }
    enc_bit(e, &ctx, 0, 1);
    enc_bit(e, &ctx, 1, r < 0);
    int ex = bit_length32(mag), i;
    for (i = 0; i < EXP_UNARY; i++) {
        int more = ex - 1 > i;
        enc_bit(e, &ctx, 2 + i, more);
        if (!more)
            break;
    }
    if (i == EXP_UNARY)
        for (int b = 3; b >= 0; b--)
            encoder_direct(e, ((ex - 15) >> b) & 1);
    if (ex > MAX_MAGNITUDE_EXP)
        return;                 /* unreachable for int16 input (as reference) */
    uint32_t mantissa = mag - (1u << (ex - 1));
    int b = ex - 2;
    if (b >= 0) { enc_bit(e, &ctx, 16, (int)((mantissa >> b) & 1u)); b--; }
    if (b >= 0) { enc_bit(e, &ctx, 17, (int)((mantissa >> b) & 1u)); b--; }
    for (; b >= 0; b--)
        encoder_direct(e, (int)((mantissa >> b) & 1u));
    push_residual(lane, r);
}

/* Returns 0, or -1 on an impossible exponent. */
static int decode_residual(range_decoder *d, nlms_cm_model *m, nlms_cm_lane *lane,
                           int32_t *r) {
    context_t ctx = make_context(m, lane);
    int32_t value = 0;
    if (dec_bit(d, &ctx, 0)) {
        int negative = dec_bit(d, &ctx, 1);
        int e = 1, i;
        for (i = 0; i < EXP_UNARY; i++) {
            if (!dec_bit(d, &ctx, 2 + i))
                break;
            e++;
        }
        if (i == EXP_UNARY) {
            int v = 0;
            for (int b = 3; b >= 0; b--)
                v |= decoder_direct(d) << b;
            e = 15 + v;
        }
        if (e > MAX_MAGNITUDE_EXP)
            return -1;
        uint32_t got = 0;
        int b = e - 2;
        if (b >= 0) { got |= (uint32_t)dec_bit(d, &ctx, 16) << b; b--; }
        if (b >= 0) { got |= (uint32_t)dec_bit(d, &ctx, 17) << b; b--; }
        for (; b >= 0; b--)
            got |= (uint32_t)decoder_direct(d) << b;
        uint32_t mag = (1u << (e - 1)) + got;
        value = negative ? -(int32_t)mag : (int32_t)mag;
    }
    push_residual(lane, value);
    *r = value;
    return 0;
}

/* ---------------- public API ---------------- */

int nlms_cm_init(nlms_cm_state *state, int epsilon, int lanes, int predictor,
             void *model) {
    if (!state || !model || ((uintptr_t)model & 3u) || epsilon < 0 ||
        epsilon > NLMS_CM_MAX_EPSILON || lanes < 1 || lanes > NLMS_CM_MAX_LANES ||
        (predictor != NLMS_CM_PRED_DELTA && predictor != NLMS_CM_PRED_NLMS))
        return -1;
    memset(state, 0, sizeof *state);
    state->epsilon = epsilon;
    state->quantiser_step = 2 * epsilon + 1;
    state->index_min = nearest_index(-32768, state->quantiser_step);
    state->index_max = nearest_index(32767, state->quantiser_step);
    state->lane_count = lanes;
    state->predictor = predictor;
    state->model = model;
    model_reset((nlms_cm_model *)model);
    return 0;
}

size_t nlms_cm_max_chunk_bytes(size_t n, int lanes) {
    if (lanes < 1) lanes = 1;
    if (lanes > NLMS_CM_MAX_LANES) lanes = NLMS_CM_MAX_LANES;
    /* <= 18 modelled decisions (<= 12 bits each) + 17 raw bits per sample */
    return NLMS_CM_CHUNK_HEADER_BYTES + 16 + n * (size_t)lanes * 30;
}

static uint8_t header_flags(const nlms_cm_state *state) {
    return (uint8_t)((NLMS_CM_VERSION << 4) | (state->predictor == NLMS_CM_PRED_NLMS));
}

size_t nlms_cm_encode_chunk(nlms_cm_state *state, const int16_t *const *in, size_t n,
                        uint8_t *out, size_t cap, nlms_cm_stats *stats) {
    if (!state || !state->model || !in || !out || n == 0 || n > UINT32_MAX ||
        cap < NLMS_CM_CHUNK_HEADER_BYTES)
        return 0;
    for (int a = 0; a < state->lane_count; a++)
        if (!in[a])
            return 0;

    range_encoder enc = { 0, 0xFFFFFFFFu, 0, 1, out + NLMS_CM_CHUNK_HEADER_BYTES,
                          cap - NLMS_CM_CHUNK_HEADER_BYTES, 0, 1 };
    nlms_cm_model *m = (nlms_cm_model *)state->model;
    nlms_cm_stats local = { 0, 0, 0 };
    const int32_t q = state->quantiser_step;
    const int lanes = state->lane_count;

    for (size_t t = 0; t < n; t++) {
        for (int a = 0; a < lanes; a++) {
            nlms_cm_lane *lane = &state->lane[a];
            int32_t x = in[a][t];
            int32_t y = nearest_index(x, q);
            uint32_t err = magnitude(x - y * q);
            if (err > (uint32_t)state->epsilon)
                return 0;
            if (err > local.max_error) local.max_error = err;
            local.sum_error += err;
            prediction_t p;
            predict(state, lane, &p);
            encode_residual(&enc, m, lane, y - p.prediction);
            predictor_update(state, lane, &p, y);
        }
        if (!enc.ok)
            return 0;
    }
    for (int i = 0; i < 5; i++)
        encoder_shift_low(&enc);
    if (!enc.ok)
        return 0;

    size_t total = NLMS_CM_CHUNK_HEADER_BYTES + enc.len;
    put_u32(out, (uint32_t)total);
    put_u32(out + 4, (uint32_t)n);
    out[8] = (uint8_t)state->lane_count;
    out[9] = header_flags(state);
    out[10] = (uint8_t)state->epsilon;
    out[11] = (uint8_t)(state->epsilon >> 8);
    local.samples = (uint64_t)n * (uint64_t)state->lane_count;
    if (stats) {
        if (local.max_error > stats->max_error)
            stats->max_error = local.max_error;
        stats->sum_error += local.sum_error;
        stats->samples += local.samples;
    }
    return total;
}

int nlms_cm_decode_chunk(nlms_cm_state *state, const uint8_t *in, size_t len,
                     int32_t *const *out, size_t n) {
    if (!state || !state->model || !in || !out || n == 0 ||
        len < NLMS_CM_CHUNK_HEADER_BYTES)
        return -1;
    if (get_u32(in) != len || get_u32(in + 4) != n ||
        in[8] != state->lane_count || in[9] != header_flags(state) ||
        (in[10] | (in[11] << 8)) != state->epsilon)
        return -1;
    for (int a = 0; a < state->lane_count; a++)
        if (!out[a])
            return -1;

    range_decoder dec = { 0, 0xFFFFFFFFu, in + NLMS_CM_CHUNK_HEADER_BYTES,
                          len - NLMS_CM_CHUNK_HEADER_BYTES, 0, 0 };
    for (int i = 0; i < 5; i++)
        dec.code = (dec.code << 8) | decoder_get(&dec);
    nlms_cm_model *m = (nlms_cm_model *)state->model;
    const int32_t q = state->quantiser_step;
    const int lanes = state->lane_count;

    for (size_t t = 0; t < n; t++) {
        for (int a = 0; a < lanes; a++) {
            nlms_cm_lane *lane = &state->lane[a];
            prediction_t p;
            predict(state, lane, &p);
            int32_t r = 0;
            if (decode_residual(&dec, m, lane, &r) != 0)
                return -1;
            int64_t y = (int64_t)p.prediction + r;
            if (y < state->index_min || y > state->index_max)
                return -1;
            out[a][t] = (int32_t)y * q;
            predictor_update(state, lane, &p, (int32_t)y);
        }
        if (dec.fail)
            return -1;
    }
    return dec.fail ? -1 : 0;
}
