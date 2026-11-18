/*
 * compact_fallback.h — exact per-block fallback shared by the BitBench
 * packages.
 *
 * The codecs map a 4096-value block to a narrow (int16/int32) domain and
 * need an exact escape hatch when that mapping does not fit.  Storing the
 * block as fixed-width int64 values costs 8 bytes per sample plus the block
 * header, i.e. the container expands.  This helper offers the smaller of
 *
 *   raw      n * 8 bytes
 *   varint   8 bytes for the first value, then one zig-zag LEB128 per
 *            wrapping int64 delta (exactly reconstructible for every input)
 *
 * "Wrapping int64 delta" means d = (uint64_t)cur - (uint64_t)prev and the
 * zig-zag map is applied to the two's-complement bit pattern, so INT64_MIN,
 * INT64_MAX and arbitrary wide values round-trip bit-exactly.
 *
 * The functions are header-only and endian-neutral on the little-endian
 * hosts the packages target (the existing wire formats already store int64
 * words with memcpy).
 */
#ifndef COMPACT_FALLBACK_H
#define COMPACT_FALLBACK_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Maximum LEB128 bytes for a uint64 value. */
#define CF_LEB_MAX 10

static inline uint64_t cf_zz_diff(uint64_t cur, uint64_t prev)
{
    uint64_t d = cur - prev;
    return (d << 1) ^ (uint64_t)(0 - (d >> 63));
}

static inline uint64_t cf_unzz(uint64_t z)
{
    return (z >> 1) ^ (uint64_t)(0 - (z & 1));
}

static inline size_t cf_uleb_len(uint64_t v)
{
    size_t n = 1;
    while (v >= 0x80) {
        v >>= 7;
        n++;
    }
    return n;
}

static inline size_t cf_put_uleb(uint8_t *p, uint64_t v)
{
    size_t n = 0;
    while (v >= 0x80) {
        p[n++] = (uint8_t)(v | 0x80);
        v >>= 7;
    }
    p[n++] = (uint8_t)v;
    return n;
}

static inline int cf_get_uleb(const uint8_t *p, size_t len, size_t *pos,
                              uint64_t *out)
{
    uint64_t v = 0;
    unsigned shift = 0;
    for (unsigned i = 0; i < CF_LEB_MAX; i++) {
        if (*pos >= len)
            return -1;
        uint8_t b = p[(*pos)++];
        if (shift == 63 && (b & 0x7E))
            return -1;                      /* would overflow uint64 */
        v |= (uint64_t)(b & 0x7F) << shift;
        if (!(b & 0x80)) {
            *out = v;
            return 0;
        }
        shift += 7;
    }
    return -1;
}

/*
 * Varint size of the deltas *after* the first value (the first value is
 * stored separately by the caller).  n == 0 is valid and costs 0 bytes.
 */
static inline size_t cf_varint_body_size(const int64_t *v, size_t n)
{
    if (n < 2)
        return 0;
    size_t bytes = 0;
    uint64_t prev = (uint64_t)v[0];
    for (size_t i = 1; i < n; i++) {
        uint64_t cur = (uint64_t)v[i];
        bytes += cf_uleb_len(cf_zz_diff(cur, prev));
        prev = cur;
    }
    return bytes;
}

/* Full varint payload: first value (8 bytes) + delta body. */
static inline size_t cf_varint_size(const int64_t *v, size_t n)
{
    return n ? 8 + cf_varint_body_size(v, n) : 0;
}

/* Size of the smallest exact fallback body: raw or varint. */
static inline size_t cf_best_size(const int64_t *v, size_t n,
                                  int *use_varint)
{
    size_t raw = n * 8;
    size_t var = cf_varint_size(v, n);
    int varint = var < raw;
    if (use_varint)
        *use_varint = varint;
    return varint ? var : raw;
}

static inline size_t cf_varint_body_encode(const int64_t *v, size_t n,
                                           uint8_t *out, size_t cap)
{
    if (n < 2)
        return 0;
    size_t pos = 0;
    uint64_t prev = (uint64_t)v[0];
    for (size_t i = 1; i < n; i++) {
        uint64_t cur = (uint64_t)v[i];
        uint64_t z = cf_zz_diff(cur, prev);
        size_t need = cf_uleb_len(z);
        if (pos + need > cap)
            return 0;
        pos += cf_put_uleb(out + pos, z);
        prev = cur;
    }
    return pos;
}

/* Encode a full varint payload (first value + body). */
static inline size_t cf_varint_encode(const int64_t *v, size_t n,
                                      uint8_t *out, size_t cap)
{
    if (!n || cap < 8)
        return 0;
    memcpy(out, v, 8);
    return 8 + cf_varint_body_encode(v, n, out + 8, cap - 8);
}

/*
 * Decode a body into v[1..n), using v[0] as the delta reference.  The body
 * must be consumed exactly; trailing bytes are rejected.
 */
static inline int cf_varint_body_decode(const uint8_t *in, size_t len,
                                        int64_t *v, size_t n)
{
    if (n < 2)
        return len == 0 ? 0 : -1;
    size_t pos = 0;
    uint64_t prev = (uint64_t)v[0];
    for (size_t i = 1; i < n; i++) {
        uint64_t z;
        if (cf_get_uleb(in, len, &pos, &z) != 0)
            return -1;
        uint64_t cur = prev + cf_unzz(z);
        v[i] = (int64_t)cur;
        prev = cur;
    }
    return pos == len ? 0 : -1;
}

/* Decode a full varint payload into n values. */
static inline int cf_varint_decode(const uint8_t *in, size_t len,
                                   int64_t *v, size_t n)
{
    if (!n)
        return len == 0 ? 0 : -1;
    if (len < 8)
        return -1;
    memcpy(v, in, 8);
    return cf_varint_body_decode(in + 8, len - 8, v, n);
}

#endif /* COMPACT_FALLBACK_H */
