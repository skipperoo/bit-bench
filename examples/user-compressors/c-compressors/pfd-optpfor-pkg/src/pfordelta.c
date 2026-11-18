/*
 * pfordelta.c — see pfordelta.h. Integer-only, no heap, no stdio.
 */
#include "pfordelta.h"

#include <stdint.h>
#include <string.h>

#define CODE_LIMIT ((uint32_t)1 << PFD_MAX_CODE_BITS)

/* ---------------- serialisation helpers ---------------- */

static void put_u16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static uint16_t get_u16(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put_u64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++)
        p[i] = (uint8_t)(v >> (8 * i));
}

static uint64_t get_u64(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++)
        v |= (uint64_t)p[i] << (8 * i);
    return v;
}

static unsigned bit_width(uint32_t v) {
#if defined(__GNUC__) || defined(__clang__)
    return v ? 32u - (unsigned)__builtin_clz(v) : 0u;
#else
    unsigned w = 0;
    while (v) {
        w++;
        v >>= 1;
    }
    return w;
#endif
}

/* ---------------- delta transform ---------------- */

static uint32_t zigzag(int32_t d) {
    uint32_t v = (uint32_t)d;
    return (v << 1) ^ (0u - (v >> 31));
}

/* Code of samples[i]: zigzag of the delta to samples[i-1] (0 for i == 0),
 * either wrapped to int16 or exact. */
static uint32_t code_at(const int16_t *x, size_t i, int wrap) {
    int32_t d = (int32_t)x[i] - (i ? (int32_t)x[i - 1] : 0);
    if (wrap)   /* sign-extend the low 16 bits */
        d = (int32_t)(((uint32_t)d & 0xFFFFu) ^ 0x8000u) - 0x8000;
    return zigzag(d);
}

/* Inverse for both delta modes: prev + unzigzag(u) mod 2^16. */
static int16_t apply_code(int16_t prev, uint32_t u) {
    uint32_t d = (u >> 1) ^ (0u - (u & 1u));
    uint32_t v = ((uint32_t)(uint16_t)prev + d) & 0xFFFFu;
    return (int16_t)(v >= 0x8000u ? (int32_t)v - 0x10000 : (int32_t)v);
}

/* ---------------- Simple16 (NewPFor exception coder) ---------------- */

/* Up to three groups of (count, bits) per selector, MSB-first under the
 * 4-bit selector; every layout fills the 28 payload bits. */
typedef struct {
    uint8_t count[3];
    uint8_t bits[3];
} s16_layout;

static const s16_layout s16_layouts[16] = {
    { { 28, 0, 0 }, { 1, 0, 0 } },
    { { 7, 14, 0 }, { 2, 1, 0 } },
    { { 7, 7, 7 },  { 1, 2, 1 } },
    { { 14, 7, 0 }, { 1, 2, 0 } },
    { { 14, 0, 0 }, { 2, 0, 0 } },
    { { 1, 8, 0 },  { 4, 3, 0 } },
    { { 1, 4, 3 },  { 3, 4, 3 } },
    { { 7, 0, 0 },  { 4, 0, 0 } },
    { { 4, 2, 0 },  { 5, 4, 0 } },
    { { 2, 4, 0 },  { 4, 5, 0 } },
    { { 3, 2, 0 },  { 6, 5, 0 } },
    { { 2, 3, 0 },  { 5, 6, 0 } },
    { { 4, 0, 0 },  { 7, 0, 0 } },
    { { 1, 2, 0 },  { 10, 9, 0 } },
    { { 2, 0, 0 },  { 14, 0, 0 } },
    { { 1, 0, 0 },  { 28, 0, 0 } },
};

/* FastPFOR's greedy Simple16 encoder: the first selector whose groups
 * (clipped to the remaining values) all fit. Writes LE u32 words; returns
 * the word count, 0 if a value needs > 28 bits or max_words is exceeded. */
static size_t s16_encode(const uint32_t *v, size_t n, uint8_t *out,
                         size_t max_words) {
    size_t pos = 0, words = 0;
    while (pos < n) {
        unsigned sel;
        for (sel = 0; sel < 16; sel++) {
            const s16_layout *l = &s16_layouts[sel];
            size_t k = pos;
            int ok = 1;
            for (int g = 0; g < 3 && ok; g++)
                for (unsigned j = 0; j < l->count[g] && k < n; j++, k++)
                    if (v[k] >> l->bits[g]) {
                        ok = 0;
                        break;
                    }
            if (ok)
                break;
        }
        if (sel == 16 || words == max_words)
            return 0;
        const s16_layout *l = &s16_layouts[sel];
        uint32_t word = (uint32_t)sel << 28;
        unsigned shift = 28;
        for (int g = 0; g < 3; g++)
            for (unsigned j = 0; j < l->count[g] && pos < n; j++, pos++) {
                shift -= l->bits[g];
                word |= v[pos] << shift;
            }
        put_u32(out + 4 * words, word);
        words++;
    }
    return words;
}

/* Decode exactly n values from `words` Simple16 words. Every word must be
 * needed and the filler bits of the last one must be zero. */
static int s16_decode(const uint8_t *in, size_t words, uint32_t *v,
                      size_t n) {
    size_t k = 0;
    for (size_t w = 0; w < words; w++) {
        if (k >= n)
            return -1;
        uint32_t word = get_u32(in + 4 * w);
        const s16_layout *l = &s16_layouts[word >> 28];
        unsigned shift = 28;
        for (int g = 0; g < 3; g++)
            for (unsigned j = 0; j < l->count[g] && k < n; j++) {
                shift -= l->bits[g];
                v[k++] = (word >> shift) & ((1u << l->bits[g]) - 1u);
            }
        if (word & ((1u << shift) - 1u))
            return -1;
    }
    return k == n ? 0 : -1;
}

/* ---------------- NewPFor ---------------- */

/* VariableByte tail shared by NewPFor and OptPFor: codes of samples[from..n),
 * low 7-bit group first, 0x80 on the last byte, payload padded to an even
 * length. Appends at out[len]; returns the new length, 0 if cap is too
 * small. */
static size_t vbyte_tail_encode(const int16_t *samples, size_t from, size_t n,
                                int wrap, uint8_t *out, size_t len,
                                size_t cap) {
    for (size_t i = from; i < n; i++) {
        uint32_t u = code_at(samples, i, wrap);
        do {
            uint8_t byte = (uint8_t)(u & 0x7Fu);
            u >>= 7;
            if (!u)
                byte |= 0x80u;
            if (len == cap)
                return 0;
            out[len++] = byte;
        } while (u);
    }
    if (len & 1u) {
        if (len == cap)
            return 0;
        out[len++] = 0;
    }
    return len;
}

/* Decode the tail into samples[out..n) from in[pos..len), continuing from
 * prev; the payload must end exactly after the padding. */
static int vbyte_tail_decode(const uint8_t *in, size_t len, size_t pos,
                             int16_t prev, int16_t *samples, size_t out,
                             size_t n) {
    while (out < n) {
        uint32_t u = 0;
        unsigned shift = 0;
        for (;;) {
            if (pos == len || shift > 14)
                return -1;
            uint8_t c = in[pos++];
            u |= (uint32_t)(c & 0x7Fu) << shift;
            shift += 7;
            if (c & 0x80u) {
                if (shift > 7 && !(c & 0x7Fu))
                    return -1;          /* non-minimal encoding */
                break;
            }
        }
        if (u >= CODE_LIMIT)
            return -1;
        prev = apply_code(prev, u);
        samples[out++] = prev;
    }
    if (pos & 1u) {
        if (pos == len || in[pos] != 0)
            return -1;
        pos++;
    }
    return pos == len ? 0 : -1;
}

/* FastPFOR possLogs narrowed to <= 17-bit codes; the last entry is the
 * exception-free fallback. */
static const uint8_t newpfor_bits[] = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17
};
#define NEWPFOR_BIT_CHOICES (sizeof newpfor_bits / sizeof newpfor_bits[0])

static int newpfor_valid_b(unsigned b) {
    return b <= 13 || b == 16 || b == 17;
}

size_t pfordelta_newpfor_max_bytes(size_t n) {
    size_t tail = n % PFD_BLOCK_SIZE;
    return (n / PFD_BLOCK_SIZE) * PFD_NEWPFOR_BLOCK_MAX_BYTES + 3 * tail +
           (tail ? 1 : 0);
}

/* Encode the 128 codes starting at samples[start]; returns bytes written,
 * 0 if cap is too small. */
static size_t newpfor_block(const int16_t *x, size_t start, int wrap,
                            uint8_t *out, size_t cap) {
    unsigned hist[PFD_MAX_CODE_BITS + 1];
    uint32_t exc[2 * PFD_NEWPFOR_MAX_EXCEPTIONS];
    unsigned b = PFD_MAX_CODE_BITS, nexc = 0;

    /* findBestB: smallest candidate with <= 10 % exceptions. Counting codes
     * by bit width gives every tryB() in one pass. */
    memset(hist, 0, sizeof hist);
    for (size_t j = 0; j < PFD_BLOCK_SIZE; j++)
        hist[bit_width(code_at(x, start + j, wrap))]++;
    for (size_t i = 0; i + 1 < NEWPFOR_BIT_CHOICES; i++) {
        unsigned above = 0;
        for (unsigned w = newpfor_bits[i] + 1u; w <= PFD_MAX_CODE_BITS; w++)
            above += hist[w];
        if (above * 10u <= PFD_BLOCK_SIZE) {
            b = newpfor_bits[i];
            nexc = above;
            break;
        }
    }

    if (nexc) {
        size_t k = 0, last = 0;
        for (size_t j = 0; j < PFD_BLOCK_SIZE; j++) {
            uint32_t u = code_at(x, start + j, wrap);
            if (!(u >> b))
                continue;
            exc[k] = (uint32_t)(k ? j - last - 1 : j);
            exc[nexc + k] = (u >> b) - 1u;
            last = j;
            k++;
        }
    }

    if (cap < PFD_NEWPFOR_HEADER_BYTES)
        return 0;
    size_t words = 0;
    if (nexc) {
        words = s16_encode(exc, 2u * nexc, out + PFD_NEWPFOR_HEADER_BYTES,
                           (cap - PFD_NEWPFOR_HEADER_BYTES) / 4);
        if (!words)
            return 0;
    }
    size_t len = PFD_NEWPFOR_HEADER_BYTES + 4 * words;
    if (cap - len < 16u * b)
        return 0;
    put_u16(out, (uint16_t)((b << 11) | (nexc << 7) | words));

    uint8_t *p = out + len;
    uint32_t mask = (1u << b) - 1u;
    uint64_t acc = 0;
    unsigned pending = 0;
    for (size_t j = 0; j < PFD_BLOCK_SIZE; j++) {
        acc |= (uint64_t)(code_at(x, start + j, wrap) & mask) << pending;
        pending += b;
        while (pending >= 8) {
            *p++ = (uint8_t)acc;
            acc >>= 8;
            pending -= 8;
        }
    }
    return len + 16u * b;
}

size_t pfordelta_newpfor_encode(const int16_t *samples, size_t n,
                                int delta_mode, uint8_t *out, size_t cap) {
    if (!samples || !out || n == 0 ||
        (delta_mode != PFD_DELTA_WRAP16 && delta_mode != PFD_DELTA_FULL17))
        return 0;
    int wrap = delta_mode == PFD_DELTA_WRAP16;
    size_t len = 0;
    size_t blocks = n / PFD_BLOCK_SIZE;

    for (size_t k = 0; k < blocks; k++) {
        size_t z = newpfor_block(samples, k * PFD_BLOCK_SIZE, wrap,
                                 out + len, cap - len);
        if (!z)
            return 0;
        len += z;
    }

    return vbyte_tail_encode(samples, blocks * PFD_BLOCK_SIZE, n, wrap, out,
                             len, cap);
}

int pfordelta_newpfor_decode(const uint8_t *in, size_t len, int16_t *samples,
                             size_t n) {
    uint32_t exc[2 * PFD_NEWPFOR_MAX_EXCEPTIONS];
    int16_t prev = 0;
    size_t pos = 0, out = 0;
    size_t blocks = n / PFD_BLOCK_SIZE;

    if (!in || !samples || n == 0)
        return -1;

    for (size_t k = 0; k < blocks; k++) {
        if (len - pos < PFD_NEWPFOR_HEADER_BYTES)
            return -1;
        unsigned h = get_u16(in + pos);
        unsigned b = h >> 11, nexc = (h >> 7) & 0xFu, words = h & 0x1Fu;
        pos += PFD_NEWPFOR_HEADER_BYTES;
        if ((h & 0x60u) || !newpfor_valid_b(b) ||
            nexc > PFD_NEWPFOR_MAX_EXCEPTIONS || (nexc == 0) != (words == 0) ||
            (b == PFD_MAX_CODE_BITS && nexc))
            return -1;
        if ((len - pos) / 4 < words)
            return -1;
        if (nexc && s16_decode(in + pos, words, exc, 2u * nexc) != 0)
            return -1;
        pos += 4u * words;
        if (len - pos < 16u * b)
            return -1;

        /* Exception positions are gap-coded; high parts are stored minus 1
         * and must keep the code below 2^17. */
        size_t e = 0, next = nexc ? exc[0] : PFD_BLOCK_SIZE;
        uint32_t mask = (1u << b) - 1u;
        uint64_t acc = 0;
        unsigned pending = 0;
        const uint8_t *p = in + pos;
        for (size_t j = 0; j < PFD_BLOCK_SIZE; j++) {
            while (pending < b) {
                acc |= (uint64_t)*p++ << pending;
                pending += 8;
            }
            uint32_t u = (uint32_t)acc & mask;
            acc >>= b;
            pending -= b;
            if (j == next) {
                uint32_t high = exc[nexc + e];
                if (high >= (CODE_LIMIT >> b) - 1u)
                    return -1;
                u |= (high + 1u) << b;
                e++;
                if (e < nexc) {
                    if (exc[e] >= PFD_BLOCK_SIZE)
                        return -1;
                    next = j + 1 + exc[e];
                }
            }
            prev = apply_code(prev, u);
            samples[out++] = prev;
        }
        if (e != nexc)
            return -1;                  /* a position fell past the block */
        pos += 16u * b;
    }
    return vbyte_tail_decode(in, len, pos, prev, samples, out, n);
}

/* ---------------- OptPFor ---------------- */

/* LSB-first bit writer/reader for the exception section. */
typedef struct {
    uint8_t *p;
    uint64_t acc;
    unsigned n;
} bit_out;

static void bo_put(bit_out *w, uint32_t v, unsigned bits) {
    w->acc |= (uint64_t)v << w->n;
    w->n += bits;
    while (w->n >= 8) {
        *w->p++ = (uint8_t)w->acc;
        w->acc >>= 8;
        w->n -= 8;
    }
}

typedef struct {
    const uint8_t *p;
    uint64_t acc;
    unsigned n;
} bit_in;

static uint32_t bi_get(bit_in *r, unsigned bits) {
    while (r->n < bits) {
        r->acc |= (uint64_t)*r->p++ << r->n;
        r->n += 8;
    }
    uint32_t v = (uint32_t)r->acc & (uint32_t)(((uint64_t)1 << bits) - 1u);
    r->acc >>= bits;
    r->n -= bits;
    return v;
}

/* Exception section size: positions as a 7-bit list or a 128-bit bitmap,
 * whichever is smaller (fixed by nexc), then nexc high parts of hb bits. */
static size_t optpfor_pos_bits(size_t nexc) {
    return nexc * 7u < PFD_BLOCK_SIZE ? nexc * 7u : PFD_BLOCK_SIZE;
}

static size_t optpfor_exc_bytes(size_t nexc, unsigned hb) {
    return nexc ? (optpfor_pos_bits(nexc) + nexc * hb + 7u) / 8u : 0;
}

size_t pfordelta_optpfor_max_bytes(size_t n) {
    size_t tail = n % PFD_BLOCK_SIZE;
    return (n / PFD_BLOCK_SIZE) * PFD_OPTPFOR_BLOCK_MAX_BYTES + 3 * tail +
           (tail ? 1 : 0);
}

/* Encode the 128 codes starting at samples[start] with the b that gives the
 * fewest bytes; returns bytes written, 0 if cap is too small. */
static size_t optpfor_block(const int16_t *x, size_t start, int wrap,
                            uint8_t *out, size_t cap) {
    uint32_t u[PFD_BLOCK_SIZE];
    unsigned hist[PFD_MAX_CODE_BITS + 1];
    uint32_t maxu = 0;

    memset(hist, 0, sizeof hist);
    for (size_t j = 0; j < PFD_BLOCK_SIZE; j++) {
        u[j] = code_at(x, start + j, wrap);
        hist[bit_width(u[j])]++;
        if (u[j] > maxu)
            maxu = u[j];
    }

    /* Exact cost of every candidate b in O(1): the exceptions are the codes
     * wider than b, and the widest high part is (maxu >> b) - 1. Ties go to
     * the larger b (fewer exceptions to patch when decoding). */
    unsigned best_i = 0, above = PFD_BLOCK_SIZE - hist[0];
    size_t best = (size_t)-1;
    for (unsigned i = 0; i < NEWPFOR_BIT_CHOICES; i++) {
        unsigned b = newpfor_bits[i];
        if (i)                             /* drop widths now inside b */
            for (unsigned w = newpfor_bits[i - 1] + 1u; w <= b; w++)
                above -= hist[w];
        if (above > PFD_OPTPFOR_MAX_EXCEPTIONS)
            continue;
        unsigned hb = above ? bit_width((maxu >> b) - 1u) : 0;
        size_t cost = PFD_NEWPFOR_HEADER_BYTES + optpfor_exc_bytes(above, hb) +
                      16u * b;
        if (cost <= best) {
            best = cost;
            best_i = i;
        }
        if (!above)
            break;                         /* larger b only adds planes */
    }

    if (best > cap)
        return 0;
    unsigned b = newpfor_bits[best_i];
    size_t nexc = 0;
    for (size_t j = 0; j < PFD_BLOCK_SIZE; j++)
        nexc += (u[j] >> b) != 0;
    unsigned hb = nexc ? bit_width((maxu >> b) - 1u) : 0;
    put_u16(out, (uint16_t)((best_i << 12) | (nexc << 5) | hb));

    bit_out w = { out + PFD_NEWPFOR_HEADER_BYTES, 0, 0 };
    if (nexc) {
        if (nexc * 7u < PFD_BLOCK_SIZE) {
            for (size_t j = 0; j < PFD_BLOCK_SIZE; j++)
                if (u[j] >> b)
                    bo_put(&w, (uint32_t)j, 7);
        } else {
            for (size_t j = 0; j < PFD_BLOCK_SIZE; j += 8) {
                uint32_t m = 0;
                for (unsigned k = 0; k < 8; k++)
                    m |= (uint32_t)((u[j + k] >> b) != 0) << k;
                bo_put(&w, m, 8);
            }
        }
        for (size_t j = 0; j < PFD_BLOCK_SIZE; j++)
            if (u[j] >> b)
                bo_put(&w, (u[j] >> b) - 1u, hb);
        if (w.n)
            bo_put(&w, 0, 8 - w.n);        /* pad to a byte */
    }

    uint32_t mask = (1u << b) - 1u;
    for (size_t j = 0; j < PFD_BLOCK_SIZE; j++)
        bo_put(&w, u[j] & mask, b);
    return best;
}

size_t pfordelta_optpfor_encode(const int16_t *samples, size_t n,
                                int delta_mode, uint8_t *out, size_t cap) {
    if (!samples || !out || n == 0 ||
        (delta_mode != PFD_DELTA_WRAP16 && delta_mode != PFD_DELTA_FULL17))
        return 0;
    int wrap = delta_mode == PFD_DELTA_WRAP16;
    size_t len = 0;
    size_t blocks = n / PFD_BLOCK_SIZE;

    for (size_t k = 0; k < blocks; k++) {
        size_t z = optpfor_block(samples, k * PFD_BLOCK_SIZE, wrap,
                                 out + len, cap - len);
        if (!z)
            return 0;
        len += z;
    }
    return vbyte_tail_encode(samples, blocks * PFD_BLOCK_SIZE, n, wrap, out,
                             len, cap);
}

int pfordelta_optpfor_decode(const uint8_t *in, size_t len, int16_t *samples,
                             size_t n) {
    int16_t prev = 0;
    size_t pos = 0, out = 0;
    size_t blocks = n / PFD_BLOCK_SIZE;

    if (!in || !samples || n == 0)
        return -1;

    for (size_t k = 0; k < blocks; k++) {
        if (len - pos < PFD_NEWPFOR_HEADER_BYTES)
            return -1;
        unsigned h = get_u16(in + pos);
        unsigned b = newpfor_bits[h >> 12];
        size_t nexc = (h >> 5) & 0x7Fu;
        unsigned hb = h & 0x1Fu;
        pos += PFD_NEWPFOR_HEADER_BYTES;
        if ((nexc == 0 && hb) || (nexc && (b + hb > PFD_MAX_CODE_BITS ||
                                           b == PFD_MAX_CODE_BITS)))
            return -1;
        size_t eb = optpfor_exc_bytes(nexc, hb);
        if (len - pos < eb + 16u * b)
            return -1;

        /* Two readers over the exception section: positions (7-bit list or
         * bitmap) and high parts, which start after the position bits. */
        int list = nexc * 7u < PFD_BLOCK_SIZE;
        size_t pb = optpfor_pos_bits(nexc);
        bit_in pr = { in + pos, 0, 0 };
        bit_in hr = { in + pos + pb / 8, 0, 0 };
        if (pb % 8)
            (void)bi_get(&hr, pb % 8);
        size_t e = 0, next = PFD_BLOCK_SIZE;
        if (nexc && list)
            next = bi_get(&pr, 7);
        if (nexc && !list) {
            unsigned ones = 0;
            for (size_t i = 0; i < PFD_BLOCK_SIZE / 8; i++)
                ones += (unsigned)__builtin_popcount(in[pos + i]);
            if (ones != nexc)
                return -1;
        }
        if (nexc) {   /* padding after the last high part must be zero */
            size_t used = pb + nexc * hb;
            if (used % 8 && (in[pos + eb - 1] >> (used % 8)))
                return -1;
        }

        bit_in lr = { in + pos + eb, 0, 0 };
        for (size_t j = 0; j < PFD_BLOCK_SIZE; j++) {
            uint32_t u = b ? bi_get(&lr, b) : 0;
            int is_exc = list ? j == next
                              : nexc && ((in[pos + j / 8] >> (j % 8)) & 1u);
            if (is_exc) {
                u |= (hb ? bi_get(&hr, hb) + 1u : 1u) << b;
                if (u >= CODE_LIMIT)
                    return -1;
                e++;
                if (list && e < nexc) {
                    next = bi_get(&pr, 7);
                    if (next <= j)
                        return -1;          /* positions must ascend */
                }
            }
            prev = apply_code(prev, u);
            samples[out++] = prev;
        }
        if (e != nexc)
            return -1;
        pos += eb + 16u * b;
    }
    return vbyte_tail_decode(in, len, pos, prev, samples, out, n);
}

/* ---------------- Simple8b-RLE ---------------- */

#define S8B_PAYLOAD_BITS   60
#define S8B_SELECTORS      13       /* 1..12 bit packing; 0 unused */
#define S8B_RLE            15u
#define S8B_RLE_VALUE_BITS PFD_MAX_CODE_BITS
#define S8B_RLE_COUNT_BITS (S8B_PAYLOAD_BITS - S8B_RLE_VALUE_BITS)
#define S8B_RLE_COUNT_MAX  (((uint64_t)1 << S8B_RLE_COUNT_BITS) - 1u)
#define S8B_LOOKAHEAD      60

static const uint8_t s8b_bits[S8B_SELECTORS] = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20
};
static const uint8_t s8b_count[S8B_SELECTORS] = {
    0, 60, 30, 20, 15, 12, 10, 8, 7, 6, 5, 4, 3
};

size_t pfordelta_simple8b_rle_max_bytes(size_t n) {
    /* Selector 12 takes three codes of any width, a run at least four. */
    return PFD_SIMPLE8B_WORD_BYTES * ((n + 2) / 3);
}

size_t pfordelta_simple8b_rle_encode(const int16_t *samples, size_t n,
                                     int delta_mode, uint8_t *out,
                                     size_t cap) {
    uint32_t win[S8B_LOOKAHEAD];
    uint8_t widest[S8B_LOOKAHEAD];      /* max bit width of win[0..j] */
    size_t pos = 0, len = 0;

    if (!samples || !out || n == 0 ||
        (delta_mode != PFD_DELTA_WRAP16 && delta_mode != PFD_DELTA_FULL17))
        return 0;
    int wrap = delta_mode == PFD_DELTA_WRAP16;

    while (pos < n) {
        size_t rem = n - pos;
        size_t look = rem < S8B_LOOKAHEAD ? rem : S8B_LOOKAHEAD;
        uint64_t word = 0;

        for (size_t j = 0; j < look; j++) {
            win[j] = code_at(samples, pos + j, wrap);
            uint8_t w = (uint8_t)bit_width(win[j]);
            widest[j] = (j && widest[j - 1] > w) ? widest[j - 1] : w;
        }

        /* tryRunLength: code a run when it beats bit packing. */
        size_t run = 1;
        while (run < look && win[run] == win[0])
            run++;
        if (run == look)
            while (pos + run < n && code_at(samples, pos + run, wrap) == win[0])
                run++;
        if ((uint64_t)bit_width(win[0] | 1u) * run >= S8B_PAYLOAD_BITS) {
            if (run > S8B_RLE_COUNT_MAX)
                run = (size_t)S8B_RLE_COUNT_MAX;
            word = ((uint64_t)S8B_RLE << S8B_PAYLOAD_BITS) |
                   ((uint64_t)run << S8B_RLE_VALUE_BITS) | win[0];
            pos += run;
        } else {
            unsigned sel;
            size_t count = 0;
            for (sel = 1; sel < S8B_SELECTORS; sel++) {
                count = s8b_count[sel] < look ? s8b_count[sel] : look;
                if (widest[count - 1] <= s8b_bits[sel])
                    break;
            }
            if (sel == S8B_SELECTORS)
                return 0;               /* unreachable for 17-bit codes */
            word = (uint64_t)sel << S8B_PAYLOAD_BITS;
            for (size_t j = 0; j < count; j++)
                word |= (uint64_t)win[j] << (j * s8b_bits[sel]);
            pos += count;
        }

        if (cap - len < PFD_SIMPLE8B_WORD_BYTES)
            return 0;
        put_u64(out + len, word);
        len += PFD_SIMPLE8B_WORD_BYTES;
    }
    return len;
}

int pfordelta_simple8b_rle_decode(const uint8_t *in, size_t len,
                                  int16_t *samples, size_t n) {
    const uint64_t payload_mask = ((uint64_t)1 << S8B_PAYLOAD_BITS) - 1u;
    int16_t prev = 0;
    size_t pos = 0, out = 0;

    if (!in || !samples || n == 0 || len % PFD_SIMPLE8B_WORD_BYTES)
        return -1;

    while (out < n) {
        if (pos == len)
            return -1;
        uint64_t word = get_u64(in + pos);
        unsigned sel = (unsigned)(word >> S8B_PAYLOAD_BITS);
        pos += PFD_SIMPLE8B_WORD_BYTES;

        if (sel == S8B_RLE) {
            uint64_t count = (word >> S8B_RLE_VALUE_BITS) & S8B_RLE_COUNT_MAX;
            uint32_t u = (uint32_t)(word & (CODE_LIMIT - 1u));
            if (count == 0 || count > (uint64_t)(n - out))
                return -1;
            for (uint64_t i = 0; i < count; i++) {
                prev = apply_code(prev, u);
                samples[out++] = prev;
            }
            continue;
        }
        if (sel == 0 || sel >= S8B_SELECTORS)
            return -1;

        unsigned bits = s8b_bits[sel];
        size_t count = s8b_count[sel];
        if (count > n - out)
            count = n - out;
        uint64_t mask = ((uint64_t)1 << bits) - 1u;
        uint64_t payload = word & payload_mask;
        for (size_t j = 0; j < count; j++) {
            uint32_t u = (uint32_t)(payload & mask);
            payload >>= bits;
            if (u >= CODE_LIMIT)
                return -1;
            prev = apply_code(prev, u);
            samples[out++] = prev;
        }
        if (payload)
            return -1;                  /* non-zero filler bits */
    }
    return pos == len ? 0 : -1;
}
