/* v23_rice.c — the shipped v23 / v24 delta + Rice format. See v23_rice.h. */
#include "v23_rice.h"

#include <stdint.h>

#define V23_MAX_CODE    131070u     /* zigzag of a 17-bit int16 difference */
#define V23_MAX_K       15
#define V23_CODE_BITS   19          /* worst Rice code with the optimal k */

int16_t v23_rice_qshift(int16_t x, int drop) {
    if (drop <= 0)
        return x;
    int32_t v = x;
    int32_t half = (int32_t)1 << (drop - 1);
    return (int16_t)(v >= 0 ? (v + half) >> drop : -((-v + half) >> drop));
}

static uint32_t zigzag(int32_t d) {
    return ((uint32_t)d << 1) ^ (uint32_t)-(int32_t)((uint32_t)d >> 31);
}

static int32_t unzigzag(uint32_t u) {
    return (int32_t)(u >> 1) ^ -(int32_t)(u & 1u);
}

static int valid_args(int axes, size_t n, int drop) {
    return axes >= 1 && axes <= V23_RICE_MAX_AXES && n > 0 &&
           drop >= 0 && drop <= V23_RICE_MAX_DROP;
}

size_t v23_rice_max_bytes(size_t n, int axes) {
    if (!valid_args(axes, n, 0))
        return 0;
    size_t total = 0;
    for (size_t start = 0; start < n; start += V23_RICE_BATCH) {
        size_t count = n - start < V23_RICE_BATCH ? n - start : V23_RICE_BATCH;
        size_t deltas = count - 1;
        size_t blocks = (deltas + V23_RICE_BLOCK - 1) / V23_RICE_BLOCK;
        size_t bits = 16 + blocks * V23_RICE_K_BITS + deltas * V23_CODE_BITS;
        total += ((size_t)axes * bits + 7) / 8;
    }
    return total;
}

/* ---------------- MSB-first bit writer ---------------- */

typedef struct {
    uint8_t *out;
    size_t cap, pos;
    uint32_t acc;                   /* < 8 pending bits between calls */
    int bits;
    int ok;
} bit_writer;

static void put_bits(bit_writer *w, uint32_t value, int width) {
    /* width <= 24, so acc never exceeds 31 bits */
    w->acc = (w->acc << width) | (value & ((1u << width) - 1u));
    w->bits += width;
    while (w->bits >= 8) {
        w->bits -= 8;
        if (w->pos < w->cap)
            w->out[w->pos] = (uint8_t)(w->acc >> w->bits);
        else
            w->ok = 0;
        w->pos++;
    }
    w->acc &= (1u << w->bits) - 1u;
}

static void put_rice(bit_writer *w, uint32_t u, int k) {
    uint32_t q = u >> k;
    while (q > 24) {
        put_bits(w, 0, 24);
        q -= 24;
    }
    put_bits(w, 1, (int)q + 1);     /* q zeros terminated by a one */
    if (k)
        put_bits(w, u, k);
}

static void align_writer(bit_writer *w) {
    if (w->bits)
        put_bits(w, 0, 8 - w->bits);
}

/* Exhaustive Rice parameter, first minimum on ties (reference _best_k). */
static int best_k(const uint32_t *u, size_t m) {
    uint32_t best_bits = UINT32_MAX;
    int best = 0;
    for (int k = 0; k <= V23_MAX_K; k++) {
        uint32_t bits = (uint32_t)m * (uint32_t)(k + 1);
        for (size_t j = 0; j < m; j++)
            bits += u[j] >> k;
        if (bits < best_bits) {
            best_bits = bits;
            best = k;
        }
    }
    return best;
}

size_t v23_rice_encode(const int16_t *const *in, int axes, size_t n, int drop,
                       uint8_t *out, size_t cap) {
    if (!in || !out || !valid_args(axes, n, drop))
        return 0;
    for (int a = 0; a < axes; a++)
        if (!in[a])
            return 0;
    bit_writer w = { out, cap, 0, 0, 0, 1 };
    uint32_t u[V23_RICE_BLOCK];
    for (size_t start = 0; start < n; start += V23_RICE_BATCH) {
        size_t count = n - start < V23_RICE_BATCH ? n - start : V23_RICE_BATCH;
        for (int a = 0; a < axes; a++) {
            const int16_t *x = in[a] + start;
            int32_t prev = v23_rice_qshift(x[0], drop);
            put_bits(&w, (uint32_t)prev & 0xFFFFu, 16);
            for (size_t off = 1; off < count; off += V23_RICE_BLOCK) {
                size_t m = count - off < V23_RICE_BLOCK ? count - off
                                                        : V23_RICE_BLOCK;
                for (size_t j = 0; j < m; j++) {
                    int32_t cur = v23_rice_qshift(x[off + j], drop);
                    u[j] = zigzag(cur - prev);
                    prev = cur;
                }
                int k = best_k(u, m);
                put_bits(&w, (uint32_t)k, V23_RICE_K_BITS);
                for (size_t j = 0; j < m; j++)
                    put_rice(&w, u[j], k);
            }
        }
        align_writer(&w);
        if (!w.ok)
            return 0;
    }
    return w.pos;
}

/* ---------------- MSB-first bit reader ---------------- */

typedef struct {
    const uint8_t *in;
    size_t len;
    size_t bit;                     /* absolute bit position */
} bit_reader;

static int get_bit(bit_reader *r, uint32_t *bit) {
    size_t byte = r->bit >> 3;
    if (byte >= r->len)
        return -1;
    *bit = (uint32_t)(r->in[byte] >> (7 - (r->bit & 7))) & 1u;
    r->bit++;
    return 0;
}

static int get_bits(bit_reader *r, int width, uint32_t *value) {
    uint32_t v = 0, b;
    for (int i = 0; i < width; i++) {
        if (get_bit(r, &b) != 0)
            return -1;
        v = (v << 1) | b;
    }
    *value = v;
    return 0;
}

static int get_rice(bit_reader *r, int k, uint32_t *u) {
    uint32_t q = 0, b, low = 0;
    uint32_t q_max = V23_MAX_CODE >> k;
    for (;;) {
        if (get_bit(r, &b) != 0)
            return -1;
        if (b)
            break;
        if (++q > q_max)
            return -1;
    }
    if (k && get_bits(r, k, &low) != 0)
        return -1;
    *u = (q << k) | low;
    return *u <= V23_MAX_CODE ? 0 : -1;
}

int v23_rice_decode(const uint8_t *in, size_t len, int axes, size_t n,
                    int drop, int32_t *const *out) {
    if (!in || !out || !valid_args(axes, n, drop))
        return -1;
    for (int a = 0; a < axes; a++)
        if (!out[a])
            return -1;
    const int32_t q_min = v23_rice_qshift(INT16_MIN, drop);
    const int32_t q_max = v23_rice_qshift(INT16_MAX, drop);
    const int32_t scale = (int32_t)1 << drop;
    bit_reader r = { in, len, 0 };
    for (size_t start = 0; start < n; start += V23_RICE_BATCH) {
        size_t count = n - start < V23_RICE_BATCH ? n - start : V23_RICE_BATCH;
        for (int a = 0; a < axes; a++) {
            int32_t *y = out[a] + start;
            uint32_t raw;
            if (get_bits(&r, 16, &raw) != 0)
                return -1;
            int32_t cur = raw >= 0x8000u ? (int32_t)raw - 0x10000
                                         : (int32_t)raw;
            if (cur < q_min || cur > q_max)
                return -1;
            y[0] = cur * scale;
            for (size_t off = 1; off < count; off += V23_RICE_BLOCK) {
                size_t m = count - off < V23_RICE_BLOCK ? count - off
                                                        : V23_RICE_BLOCK;
                uint32_t k;
                if (get_bits(&r, V23_RICE_K_BITS, &k) != 0)
                    return -1;
                for (size_t j = 0; j < m; j++) {
                    uint32_t u;
                    if (get_rice(&r, (int)k, &u) != 0)
                        return -1;
                    cur += unzigzag(u);
                    if (cur < q_min || cur > q_max)
                        return -1;
                    y[off + j] = cur * scale;
                }
            }
        }
        while (r.bit & 7) {         /* the padding must be zero */
            uint32_t b;
            if (get_bit(&r, &b) != 0 || b)
                return -1;
        }
    }
    return (r.bit >> 3) == len ? 0 : -1;
}
