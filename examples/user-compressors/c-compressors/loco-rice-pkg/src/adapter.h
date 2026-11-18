/* LOCO-Rice (lib/loco_rice.h): 1-D JPEG-LS (LOCO-I) model, near-lossless step
 * 2*eps + 1, adaptive Rice; state carried across chunks. Level = eps. */
#include "loco_rice.h"
#define PKG_NAME          "loco_rice"
#define PKG_MAGIC         "LOCR"
#define PKG_LEVEL_KEY     "epsilon"
#define PKG_LEVEL_MAX     LOCO_RICE_MAX_EPS
#define PKG_LEVEL_DEFAULT 2
#define PKG_STATEFUL      1
#define PKG_TEST_LEVELS   0, 1, 2, 4, 8, 255
typedef struct { loco_rice_state st; } ad_state;
static int16_t ad_tmp[4096];
static inline uint64_t ad_bound(int level) { return (uint64_t)level; }
static inline int ad_init(ad_state *s, int level) { return loco_rice_init(&s->st, level); }
static inline size_t ad_max_bytes(size_t n) { return loco_rice_max_chunk_bytes(n); }
static inline size_t ad_encode(ad_state *s, const int16_t *x, size_t n, uint8_t *out, size_t cap) {
    return loco_rice_encode_chunk(&s->st, x, n, out, cap);
}
static inline int ad_decode(ad_state *s, const uint8_t *in, size_t len, int32_t *rec, size_t n) {
    if (n > 4096 || loco_rice_decode_chunk(&s->st, in, len, ad_tmp, n) != 0)
        return -1;
    for (size_t i = 0; i < n; i++)
        rec[i] = ad_tmp[i];
    return 0;
}
