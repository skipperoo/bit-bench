/* DPCM-Range (lib/dpcm_range.h): DPCM on the step 2*eps + 1 grid (eps = 0 is
 * lossless), 204-context adaptive binary range coder; state carried across
 * chunks. Level = eps. */
#include "dpcm_range.h"
#define PKG_NAME          "dpcm_range"
#define PKG_MAGIC         "DPRG"
#define PKG_LEVEL_KEY     "epsilon"
#define PKG_LEVEL_MAX     32767
#define PKG_LEVEL_DEFAULT 2
#define PKG_STATEFUL      1
#define PKG_TEST_LEVELS   0, 1, 2, 4, 8, 1000
/* The probability table lives in the state, so a struct copy is a full
 * snapshot; its pointer always refers to the copy that is used (enc or dec). */
typedef struct {
    dpcm_range_state st;
    uint8_t probs[DPCM_RANGE_CONTEXTS * DPCM_RANGE_CONTEXT_BYTES];
} ad_state;
static inline uint64_t ad_bound(int level) { return (uint64_t)level; }
static inline int ad_init(ad_state *s, int level) {
    dpcm_range_init(&s->st, level, 1, s->probs);
    return 0;
}
static inline size_t ad_max_bytes(size_t n) { return dpcm_range_max_chunk_bytes(n, 1); }
static inline size_t ad_encode(ad_state *s, const int16_t *x, size_t n, uint8_t *out, size_t cap) {
    const int16_t *in[1] = { x };
    s->st.probabilities = s->probs;
    return dpcm_range_encode_chunk(&s->st, in, n, out, cap, NULL);
}
static inline int ad_decode(ad_state *s, const uint8_t *in, size_t len, int32_t *rec, size_t n) {
    int32_t *o[1] = { rec };
    s->st.probabilities = s->probs;
    return dpcm_range_decode_chunk(&s->st, in, len, o, n);
}
