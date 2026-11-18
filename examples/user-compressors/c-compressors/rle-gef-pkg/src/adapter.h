/* RLE-GEF (lib/rle_gef.h): run-length + generalized Elias-Fano layout of the
 * int16 values; lossy rows code the LSB-dropped quotients (level = drop d).
 * Stateless. */
#include "rle_gef.h"
#include "_drop.h"
#define PKG_NAME          "rle_gef"
#define PKG_MAGIC         "RGEF"
#define PKG_LEVEL_KEY     "drop_bits"
#define PKG_LEVEL_MAX     15
#define PKG_LEVEL_DEFAULT 2
#define PKG_STATEFUL      0
#define PKG_TEST_LEVELS   0, 1, 2, 3, 8
typedef struct { int drop; } ad_state;
static int16_t ad_q[4096], ad_d[4096];
static inline uint64_t ad_bound(int level) { return ad_drop_bound(level); }
static inline int ad_init(ad_state *s, int level) { s->drop = level; return 0; }
static inline size_t ad_max_bytes(size_t n) { return rle_gef_i16_blob_size_max(n); }
static inline size_t ad_encode(ad_state *s, const int16_t *x, size_t n, uint8_t *out, size_t cap) {
    rle_gef_i16 r;
    if (n > 4096) return 0;
    for (size_t i = 0; i < n; i++) ad_q[i] = ad_drop(x[i], s->drop);
    rle_gef_i16_init(&r);
    int len = rle_gef_i16_build(&r, ad_q, n) == 0 ? rle_gef_i16_pack(&r, out, cap) : -1;
    rle_gef_i16_destroy(&r);
    return len > 0 ? (size_t)len : 0;
}
static inline int ad_decode(ad_state *s, const uint8_t *in, size_t len, int32_t *rec, size_t n) {
    rle_gef_i16 r;
    if (n > 4096) return -1;
    rle_gef_i16_init(&r);
    int ok = rle_gef_i16_unpack(&r, in, len) == 0 &&
             rle_gef_i16_get_elements(&r, 0, n, ad_d) == n && rle_gef_i16_size(&r) == n;
    rle_gef_i16_destroy(&r);
    if (!ok) return -1;
    for (size_t i = 0; i < n; i++) rec[i] = (int32_t)ad_d[i] * ((int32_t)1 << s->drop);
    return 0;
}
