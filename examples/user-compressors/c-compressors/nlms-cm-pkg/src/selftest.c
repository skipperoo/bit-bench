/* Package smoke test: NLMS-CM multi-chunk round trips for both predictors. */
#include "nlms_cm.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned s = 7;
static unsigned rnd(void) { s = s * 1103515245u + 12345u; return s; }

static uint32_t model_enc[NLMS_CM_MODEL_BYTES / 4], model_dec[NLMS_CM_MODEL_BYTES / 4];

int main(void) {
    enum { N = 12000, CN = 4096 };
    static int16_t x[N];
    static int32_t y[N];
    static uint8_t buf[N * 4 + 4096];
    static const int eps_list[] = { 0, 1, 2, 8, 32, 32767 };
    unsigned long checks = 0, bad = 0;
    for (int pred = 0; pred < 2; pred++) {
        for (size_t k = 0; k < sizeof eps_list / sizeof eps_list[0]; k++) {
            int eps = eps_list[k];
            int v = 0;
            for (int i = 0; i < N; i++) {
                v += (int)(rnd() % 2001) - 1000;
                if (i % 3001 == 3000) v = (i & 1) ? 32767 : -32768;
                if (v > 32767) v = 32767;
                if (v < -32768) v = -32768;
                x[i] = (int16_t)v;
            }
            nlms_cm_state enc, dec;
            if (nlms_cm_init(&enc, eps, 1, pred, model_enc) != 0 ||
                nlms_cm_init(&dec, eps, 1, pred, model_dec) != 0) {
                bad++;
                continue;
            }
            for (int off = 0; off < N; off += CN) {
                size_t cn = N - off < CN ? (size_t)(N - off) : CN;
                const int16_t *in[1] = { x + off };
                int32_t *out[1] = { y + off };
                nlms_cm_stats st = { 0, 0, 0 };
                size_t z = nlms_cm_encode_chunk(&enc, in, cn, buf, sizeof buf, &st);
                checks++;
                if (!z || nlms_cm_decode_chunk(&dec, buf, z, out, cn) != 0) {
                    bad++;
                    break;
                }
                checks++;
                if (st.max_error > (uint64_t)eps) bad++;
                checks++;
                for (size_t i = 0; i < cn; i++) {
                    int e = x[off + i] - y[off + i];
                    if (e < -eps || e > eps) { bad++; break; }
                }
                /* A truncated payload must be rejected, not overrun. */
                nlms_cm_state probe = dec;
                checks++;
                if (nlms_cm_decode_chunk(&probe, buf, NLMS_CM_CHUNK_HEADER_BYTES - 1,
                                     out, cn) == 0)
                    bad++;
            }
        }
    }
    printf("nlms_cm selftest: %lu checks, %lu failures\n", checks, bad);
    return bad ? 1 : 0;
}
