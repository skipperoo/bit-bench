/*
 * loco_rice.c — LOCO-Rice 1-D near-lossless coder (see loco_rice.h).
 */
#include "loco_rice.h"

#include <string.h>

#define ACT_BINS  12
#define ULIMIT    24        /* unary zeros before the escape */
#define ESC_BITS  18
#define RESET_N   64

/* ---------------- bit writer (MSB first) ---------------- */

typedef struct {
    uint8_t *p, *end;
    uint32_t acc;
    int n;
    int ok;
} bit_writer;

static inline void bw_put(bit_writer *w, uint32_t v, int bits)    /* 1..24 */
{
    w->acc = (w->acc << bits) | (v & ((1u << bits) - 1u));
    w->n += bits;
    while (w->n >= 8) {
        w->n -= 8;
        if (w->p == w->end) { w->ok = 0; return; }
        *w->p++ = (uint8_t)(w->acc >> w->n);
    }
}

static inline void bw_zeros(bit_writer *w, int count)
{
    while (count > 16) { bw_put(w, 0, 16); count -= 16; }
    if (count) bw_put(w, 0, count);
}

/* ---------------- bit reader ---------------- */

/* 32-bit window, zero-filled past the end; `left` counts the payload bits
 * not yet consumed and ok drops to 0 when more are consumed. */
typedef struct {
    const uint8_t *p, *end;
    uint32_t acc;
    int n;
    uint32_t left;
    int ok;
} bit_reader;

static inline void br_fill(bit_reader *r)
{
    while (r->n <= 24) {
        uint32_t b = r->p < r->end ? *r->p++ : 0;
        r->acc |= b << (24 - r->n);
        r->n += 8;
    }
}

static inline void br_skip(bit_reader *r, int bits)
{
    r->acc <<= bits;
    r->n -= bits;
    if ((uint32_t)bits > r->left) { r->ok = 0; r->left = 0; }
    else r->left -= (uint32_t)bits;
}

static inline uint32_t br_get(bit_reader *r, int bits)             /* 1..24 */
{
    br_fill(r);
    uint32_t v = r->acc >> (32 - bits);
    br_skip(r, bits);
    return v;
}

/* Zeros up to `limit`, then a 1: returns the count and consumes the 1;
 * returns `limit` after consuming exactly `limit` zeros (escape). */
static inline int br_unary(bit_reader *r, int limit)
{
    int u = 0;
    for (;;) {
        br_fill(r);
        int z = r->acc ? __builtin_clz(r->acc) : r->n;
        if (u + z >= limit) { br_skip(r, limit - u); return limit; }
        if (r->acc) { br_skip(r, z + 1); return u + z; }
        br_skip(r, z);
        u += z;
        if (!r->ok) return limit;
    }
}

/* ---------------- model ---------------- */

void loco_rice_reset(loco_rice_state *s)
{
    if (!s)
        return;
    for (int i = 0; i < LOCO_RICE_CONTEXTS; i++) {
        s->A[i] = 4;
        s->B[i] = 0;
        s->C[i] = 0;
        s->N[i] = 1;
    }
    s->y1 = s->y2 = s->y3 = 0;
    s->started = 0;
}

int loco_rice_init(loco_rice_state *s, int eps)
{
    if (!s || eps < 0 || eps > LOCO_RICE_MAX_EPS)
        return -1;
    memset(s, 0, sizeof *s);
    s->eps = (int16_t)eps;
    uint32_t step = 2u * (uint32_t)eps + 1u;
    /* ceil(2^32 / step); unused for step 1, where no division is needed. */
    s->recip = step > 1 ? (uint32_t)((0xFFFFFFFFull + step) / step) : 0u;
    loco_rice_reset(s);
    return 0;
}

size_t loco_rice_max_chunk_bytes(size_t n)
{
    if (n == 0 || n > LOCO_RICE_MAX_CHUNK)
        return 0;
    return LOCO_RICE_HEADER_BYTES + (n * (ULIMIT + 1 + ESC_BITS) + 7) / 8;
}

/* floor(a / step) for a < 2^17, step = 2eps + 1 <= 511 (exact). */
static inline uint32_t div_step(const loco_rice_state *s, uint32_t a)
{
    return s->recip ? (uint32_t)(((uint64_t)a * s->recip) >> 32) : a;
}

static inline int bit_length(uint32_t v)
{
    return v ? 32 - __builtin_clz(v) : 0;
}

static inline int32_t clamp16(int32_t v)
{
    return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

static inline int context(const loco_rice_state *s, int *sgn)
{
    int32_t d1 = s->y1 - s->y2, d2 = s->y2 - s->y3;
    uint32_t act = (uint32_t)(d1 < 0 ? -d1 : d1) + (uint32_t)(d2 < 0 ? -d2 : d2);
    int a = bit_length(div_step(s, act));
    if (a >= ACT_BINS)
        a = ACT_BINS - 1;
    *sgn = d1 < 0 ? -1 : 1;
    return a * 2 + ((d1 ^ d2) >= 0);
}

static inline int rice_k(const loco_rice_state *s, int c)
{
    int k = 0;
    int32_t n = s->N[c], a = s->A[c];
    while ((n << k) < a && k < 17)
        k++;
    return k;
}

static inline void update(loco_rice_state *s, int c, int32_t q, int32_t step)
{
    s->A[c] += q < 0 ? -q : q;
    s->B[c] += q * step;
    int32_t n = s->N[c];
    if (s->B[c] <= -n) {
        if (s->C[c] > -32767) s->C[c]--;
        s->B[c] += n;
        if (s->B[c] <= -n) s->B[c] = -n + 1;
    } else if (s->B[c] > 0) {
        if (s->C[c] < 32767) s->C[c]++;
        s->B[c] -= n;
        if (s->B[c] > 0) s->B[c] = 0;
    }
    if (++s->N[c] >= RESET_N) {
        s->A[c] >>= 1;
        s->B[c] >>= 1;          /* arithmetic shift (floor), as JPEG-LS */
        s->N[c] >>= 1;
    }
}

static inline void push(loco_rice_state *s, int32_t y)
{
    s->y3 = s->y2;
    s->y2 = s->y1;
    s->y1 = y;
}

/* ---------------- encoder ---------------- */

size_t loco_rice_encode_chunk(loco_rice_state *s, const int16_t *x, size_t n,
                              uint8_t *out, size_t cap)
{
    if (!s || !x || !out || n == 0 || n > LOCO_RICE_MAX_CHUNK ||
        cap < LOCO_RICE_HEADER_BYTES)
        return 0;
    out[0] = (uint8_t)n;
    out[1] = (uint8_t)(n >> 8);
    out[2] = (uint8_t)s->eps;
    out[3] = s->started ? 1u : 0u;
    s->started = 1;

    bit_writer w = { out + LOCO_RICE_HEADER_BYTES, out + cap, 0, 0, 1 };
    const int32_t eps = s->eps, step = 2 * eps + 1;

    for (size_t i = 0; i < n; i++) {
        int sgn;
        int c = context(s, &sgn);
        int32_t P = clamp16(s->y1 + sgn * s->C[c]);
        int32_t e = ((int32_t)x[i] - P) * sgn;
        int32_t q = e >= 0 ? (int32_t)div_step(s, (uint32_t)(e + eps))
                           : -(int32_t)div_step(s, (uint32_t)(-e + eps));
        int32_t y = clamp16(P + sgn * q * step);

        uint32_t m = q >= 0 ? (uint32_t)q << 1 : ((uint32_t)(-q) << 1) - 1u;
        int k = rice_k(s, c);
        uint32_t u = m >> k;
        if (u < ULIMIT) {
            bw_zeros(&w, (int)u);
            bw_put(&w, 1, 1);
            if (k)
                bw_put(&w, m, k);
        } else {
            bw_zeros(&w, ULIMIT);
            bw_put(&w, 1, 1);
            bw_put(&w, m, ESC_BITS);
        }
        update(s, c, q, step);
        push(s, y);
    }
    if (w.n)
        bw_put(&w, 0, 8 - w.n);
    return w.ok ? (size_t)(w.p - out) : 0;
}

/* ---------------- decoder ---------------- */

int loco_rice_decode_chunk(loco_rice_state *s, const uint8_t *in, size_t len,
                           int16_t *y, size_t n)
{
    if (!s || !in || !y || n == 0 || n > LOCO_RICE_MAX_CHUNK ||
        len <= LOCO_RICE_HEADER_BYTES || len > LOCO_RICE_HEADER_BYTES + 0x0FFFFFFFu)
        return -1;
    size_t hn = (size_t)in[0] | ((size_t)in[1] << 8);
    if (hn != n || in[2] != (uint8_t)s->eps || (in[3] & ~1u))
        return -1;
    if (in[3] & 1u) {
        if (!s->started)
            return -1;          /* continues a chunk this decoder never saw */
    } else {
        loco_rice_reset(s);
    }
    s->started = 1;

    bit_reader r = { in + LOCO_RICE_HEADER_BYTES, in + len, 0, 0,
                     (uint32_t)(len - LOCO_RICE_HEADER_BYTES) * 8u, 1 };
    const int32_t step = 2 * s->eps + 1;

    for (size_t i = 0; i < n; i++) {
        int sgn;
        int c = context(s, &sgn);
        int32_t P = clamp16(s->y1 + sgn * s->C[c]);
        int k = rice_k(s, c);
        int u = br_unary(&r, ULIMIT);
        uint32_t m;
        if (u < ULIMIT) {
            m = ((uint32_t)u << k) | (k ? br_get(&r, k) : 0u);
        } else {
            if (br_get(&r, 1) != 1u)
                return -1;
            m = br_get(&r, ESC_BITS);
        }
        if (!r.ok)
            return -1;
        int32_t q = (m & 1u) ? -(int32_t)((m + 1u) >> 1) : (int32_t)(m >> 1);
        int32_t v = clamp16(P + sgn * q * step);
        y[i] = (int16_t)v;
        update(s, c, q, step);
        push(s, v);
    }
    /* Only zero padding of the last byte may remain. */
    if (r.left >= 8)
        return -1;
    if (r.left && br_get(&r, (int)r.left) != 0u)
        return -1;
    return 0;
}
