/* PFD-NewPFor (lib/pfordelta.h): zig-zag int16 wrap-around delta + NewPFor
 * blocks (16-bit re-pack of the FastPFOR scheme); lossy rows code the
 * LSB-dropped quotients (level = drop d). Stateless, no workspace. */
#include "pfordelta.h"
#include "_drop.h"
#define PKG_NAME          "pfd_newpfor"
#define PKG_MAGIC         "PFNP"
#define PKG_LEVEL_KEY     "drop_bits"
#define PKG_LEVEL_MAX     15
#define PKG_LEVEL_DEFAULT 2
#define PKG_STATEFUL      0
#define PKG_TEST_LEVELS   0, 1, 2, 3, 8
typedef struct { int drop; } ad_state;
static int16_t ad_q[4096], ad_d[4096];
static inline uint64_t ad_bound(int level) { return ad_drop_bound(level); }
static inline int ad_init(ad_state *s, int level) { s->drop = level; return 0; }
static inline size_t ad_max_bytes(size_t n) { return pfordelta_newpfor_max_bytes(n); }
static inline size_t ad_encode(ad_state *s, const int16_t *x, size_t n, uint8_t *out, size_t cap) {
    if (n > 4096) return 0;
    for (size_t i = 0; i < n; i++) ad_q[i] = ad_drop(x[i], s->drop);
    return pfordelta_newpfor_encode(ad_q, n, PFD_DELTA_WRAP16, out, cap);
}
static inline int ad_decode(ad_state *s, const uint8_t *in, size_t len, int32_t *rec, size_t n) {
    if (n > 4096 || pfordelta_newpfor_decode(in, len, ad_d, n) != 0) return -1;
    for (size_t i = 0; i < n; i++) rec[i] = (int32_t)ad_d[i] * ((int32_t)1 << s->drop);
    return 0;
}
