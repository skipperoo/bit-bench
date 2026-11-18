/* Package smoke test (generated from scripts/pkg_template/selftest.c):
 * multi-chunk round trips of the codec through adapter.h on random walks with
 * jumps to the int16 extremes; level 0 must be exact, every other level must
 * stay within its bound. */
#include "adapter.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned s = 7;
static unsigned rnd(void) { s = s * 1103515245u + 12345u; return s >> 1; }

int main(void) {
    enum { N = 12000, CN = 4096 };
    static int16_t x[N];
    static int32_t y[CN];
    static const int levels[] = { PKG_TEST_LEVELS };
    static const int steps[] = { 3, 60, 2000 };
    size_t cap = ad_max_bytes(CN);
    uint8_t *buf = malloc(cap);
    ad_state *enc = malloc(sizeof *enc), *dec = malloc(sizeof *dec);
    unsigned long checks = 0, bad = 0;
    if (!buf || !enc || !dec) return 1;
    for (size_t k = 0; k < sizeof levels / sizeof levels[0]; k++) {
        int level = levels[k];
        uint64_t bound = ad_bound(level);
        for (size_t st = 0; st < sizeof steps / sizeof steps[0]; st++) {
            int v = 0;
            for (int i = 0; i < N; i++) {
                v += (int)(rnd() % (unsigned)(2 * steps[st] + 1)) - steps[st];
                if (i % 3001 == 3000) v = (i & 1) ? 32767 : -32768;
                if (v > 32767) v = 32767;
                if (v < -32768) v = -32768;
                x[i] = (int16_t)v;
            }
            checks++;
            if (ad_init(enc, level) != 0 || ad_init(dec, level) != 0) { bad++; continue; }
            for (int off = 0; off < N; off += CN) {
                size_t cn = N - off < CN ? (size_t)(N - off) : CN;
                size_t z = ad_encode(enc, x + off, cn, buf, cap);
                checks++;
                if (!z || ad_decode(dec, buf, z, y, cn) != 0) {
                    fprintf(stderr, "level %d step %d chunk %d: codec error\n",
                            level, steps[st], off / CN);
                    bad++;
                    break;
                }
                for (size_t i = 0; i < cn; i++) {
                    int64_t e = (int64_t)x[off + i] - y[i];
                    uint64_t a = (uint64_t)(e < 0 ? -e : e);
                    checks++;
                    if (a > bound) {
                        if (bad < 10)
                            fprintf(stderr, "level %d: |err| %llu > %llu at %d\n", level,
                                    (unsigned long long)a, (unsigned long long)bound,
                                    off + (int)i);
                        bad++;
                    }
                }
            }
        }
    }
    printf(PKG_NAME " selftest: %lu checks, %lu failures\n", checks, bad);
    free(buf); free(enc); free(dec);
    return bad != 0;
}
