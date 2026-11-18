/* Delta+Rice: the shipped v23/v24 delta + Rice format (lib/v23_rice.h), one axis.
 * Level = LSB drop d (0 = lossless v23, 1..7 = v24 lossy_qshift). Stateless. */
#include "v23_rice.h"
#define PKG_NAME          "delta_rice"
#define PKG_MAGIC         "DRCE"
#define PKG_LEVEL_KEY     "drop_bits"
#define PKG_LEVEL_MAX     V23_RICE_MAX_DROP
#define PKG_LEVEL_DEFAULT 2
#define PKG_STATEFUL      0
#define PKG_TEST_LEVELS   0, 1, 2, 3, 7
typedef struct { int drop; } ad_state;
static inline uint64_t ad_bound(int level) { return level ? (uint64_t)1 << (level - 1) : 0; }
static inline int ad_init(ad_state *s, int level) { s->drop = level; return 0; }
static inline size_t ad_max_bytes(size_t n) { return v23_rice_max_bytes(n, 1); }
static inline size_t ad_encode(ad_state *s, const int16_t *x, size_t n, uint8_t *out, size_t cap) {
    const int16_t *in[1] = { x };
    return v23_rice_encode(in, 1, n, s->drop, out, cap);
}
static inline int ad_decode(ad_state *s, const uint8_t *in, size_t len, int32_t *rec, size_t n) {
    int32_t *o[1] = { rec };
    return v23_rice_decode(in, len, 1, n, s->drop, o);
}
