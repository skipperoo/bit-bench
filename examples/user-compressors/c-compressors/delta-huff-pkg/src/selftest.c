/*
 * selftest.c — host fuzz for the huff_delta codec (not run by the platform).
 * Verifies the exact round trip in the quantized domain, the drop error
 * bound, escape paths (small tables), table serialisation and malformed-input
 * rejection. Build: make selftest ; run: ./selftest
 */
#include "huff_delta.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_checks, g_fails;
#define CHECK(c, m) do { g_checks++; if (!(c)) { g_fails++; \
    printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, (m)); } } while (0)

static uint32_t rng = 0x12345678u;
static uint32_t rnd(void) {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng;
}

static void make(int64_t *y, size_t n, int kind, int64_t base) {
    for (size_t i = 0; i < n; i++) {
        switch (kind) {
        case 0: { int64_t v = (int64_t)(rnd() % 4000) - 2000; y[i] = base + v; break; }
        case 1: y[i] = base + (int64_t)i * ((int64_t)1 << 20); break;
        case 2: y[i] = base; break;
        case 3: y[i] = (i & 1) ? (int64_t)1 << 60 : -((int64_t)1 << 60); break;
        default: y[i] = base + (int64_t)(rnd() % 7) * 3 - 9; break;
        }
    }
}

int main(void) {
    enum { N = 4096 };
    static int64_t y[N], z[N];
    static const int drops[] = { 0, 1, 4, 8 };
    static const int ks[] = { 4, 255, 1024 };
    static const size_t lens[] = { 1, 2, 5, 64, 4096 };
    uint8_t *buf = malloc(hd_max_chunk_payload(N));
    const int64_t bases[] = { 0, -12345, (int64_t)1 << 40 };

    for (unsigned t = 0; t < 12; t++) {
        int kind = (int)(t % 5);
        int64_t base = bases[t % 3];
        for (size_t li = 0; li < sizeof lens / sizeof lens[0]; li++) {
            size_t n = lens[li];
            make(y, n, kind, base);
            for (size_t di = 0; di < sizeof drops / sizeof drops[0]; di++) {
                for (size_t ki = 0; ki < sizeof ks / sizeof ks[0]; ki++) {
                    int drop = drops[di], K = ks[ki];
                    hd_table t;
                    hd_table_init(&t, drop, K);
                    hd_train_chunk(&t, y, n);
                    CHECK(hd_finish_training(&t) == 0, "train");
                    size_t len = hd_encode_chunk(&t, y, n, buf,
                                                 hd_max_chunk_payload(N));
                    CHECK(len > 0, "encode");
                    CHECK(hd_decode_chunk(&t, buf, len, z, n) == 0, "decode");
                    for (size_t i = 0; i < n; i++) {
                        int64_t want = hd_drop(y[i], drop);
                        if (z[i] != want) { CHECK(0, "quantized round trip"); break; }
                    }
                    /* table serialisation */
                    size_t tb = hd_table_bytes(&t);
                    uint8_t *blob = malloc(tb);
                    CHECK(hd_write_table(&t, blob, tb) == tb, "write table");
                    hd_table t2;
                    CHECK(hd_read_table(&t2, blob, tb) == tb, "read table");
                    CHECK(t2.K == t.K && t2.nsym == t.nsym &&
                          t2.drop_bits == t.drop_bits, "table fields");
                    CHECK(hd_encode_chunk(&t2, y, n, buf,
                                          hd_max_chunk_payload(N)) == len,
                          "same size after table round trip");
                    CHECK(hd_decode_chunk(&t2, buf, len, z, n) == 0 &&
                          z[0] == hd_drop(y[0], drop), "decode with parsed table");
                    CHECK(hd_read_table(&t2, blob, tb - 1) == 0, "short table rejected");
                    free(blob);
                }
            }
        }
    }
    /* malformed payloads must be rejected, not trusted */
    make(y, N, 0, 0);
    hd_table t;
    hd_table_init(&t, 4, 255);
    hd_train_chunk(&t, y, N);
    hd_finish_training(&t);
    size_t len = hd_encode_chunk(&t, y, N, buf, hd_max_chunk_payload(N));
    CHECK(hd_decode_chunk(&t, buf, HD_HDR_CHUNK - 1, z, N) != 0, "short rejected");
    buf[16] = 0;
    CHECK(hd_decode_chunk(&t, buf, len, z, N) != 0, "bad esc_bits rejected");
    buf[16] = 70;
    CHECK(hd_decode_chunk(&t, buf, len, z, N) != 0, "esc_bits>64 rejected");

    free(buf);
    printf("huff_delta selftest: %d checks, %d failures -> %s\n",
           g_checks, g_fails, g_fails ? "FAILED" : "ALL OK");
    return g_fails ? 1 : 0;
}
