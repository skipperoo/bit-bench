/*
 * bench_capture.c — benchmark the huff_delta codec on the real device
 * capture (RSA1 dump produced by scripts/convert_sa_test.py) with the same
 * reporting style as the lib/ simulators: compressed/original ratio,
 * bits/sample, max/mean error, throughput, table + working memory, and a
 * round-trip verification of every chunk.
 *
 * Usage: ./bench [--drop-bits N] [--table-k K] [--train-chunks N]
 *                 [--limit N] [path]
 */
#define _POSIX_C_SOURCE 200809L

#include "huff_delta.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CHUNK 4096
#define FULL_MAGIC "RSA1"

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
    const char *path = "build/sa_test_full_i16.bin";
    int drop_bits = 4, K = 255, train = 8;
    long limit = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--drop-bits") && i + 1 < argc) drop_bits = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--table-k") && i + 1 < argc) K = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--train-chunks") && i + 1 < argc) train = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--limit") && i + 1 < argc) limit = atol(argv[++i]);
        else if (argv[i][0] != '-') path = argv[i];
    }
    if (drop_bits < 0 || drop_bits > 15 || K < 1 || K > HD_MAX_K) {
        fputs("bad parameters\n", stderr);
        return 1;
    }

    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot read %s\n", path); return 1; }
    char magic[4];
    uint32_t axes, samples;
    if (fread(magic, 1, 4, f) != 4 || memcmp(magic, FULL_MAGIC, 4) != 0 ||
        fread(&axes, 4, 1, f) != 1 || fread(&samples, 4, 1, f) != 1) {
        fprintf(stderr, "%s: expected an RSA1 dump\n", path);
        return 1;
    }
    printf("capture   : %s | %u axes x %u samples\n", path, axes, samples);
    printf("codec     : huff_delta | drop_bits=%d K=%d (%u symbols) "
           "train=%d chunks\n\n", drop_bits, K, 2u * K + 2u, train);

    size_t n = limit > 0 && (uint32_t)limit < samples ? (size_t)limit : samples;
    size_t nchunks = (n + CHUNK - 1) / CHUNK;
    int64_t *x = malloc(samples * 8);          /* int64 view of one axis */
    int64_t *dec = malloc(CHUNK * 8);
    size_t cap = hd_max_chunk_payload(CHUNK);
    uint8_t *buf = malloc(cap);

    double t_train = 0, t_comp = 0, t_decomp = 0;
    size_t total_table = 0, total_payload = 0;
    uint64_t max_err = 0;
    long double sum_err = 0;
    size_t bad = 0;

    for (uint32_t a = 0; a < axes; a++) {
        int16_t *raw = malloc(samples * 2);
        if (fread(raw, 2, samples, f) != samples) return 1;
        for (uint32_t i = 0; i < samples; i++)
            x[i] = raw[i];
        free(raw);

        hd_table table;
        double t0 = now_s();
        hd_table_init(&table, drop_bits, K);
        for (int c = 0; c < train && (size_t)c < nchunks; c++) {
            size_t off = (size_t)c * CHUNK;
            size_t cn = n - off < CHUNK ? n - off : CHUNK;
            hd_train_chunk(&table, x + off, cn);
        }
        if (hd_finish_training(&table) != 0) {
            fprintf(stderr, "axis %u: no symbols\n", a);
            return 1;
        }
        t_train += now_s() - t0;
        total_table += hd_table_bytes(&table);

        size_t axis_payload = 0;
        for (size_t c = 0; c < nchunks; c++) {
            size_t off = c * CHUNK;
            size_t cn = n - off < CHUNK ? n - off : CHUNK;
            t0 = now_s();
            size_t len = hd_encode_chunk(&table, x + off, cn, buf, cap);
            t_comp += now_s() - t0;
            if (!len || len > cap) {
                fprintf(stderr, "axis %u chunk %zu: encode failed\n", a, c);
                return 1;
            }
            axis_payload += len;
            t0 = now_s();
            if (hd_decode_chunk(&table, buf, len, dec, cn) != 0) {
                fprintf(stderr, "axis %u chunk %zu: decode failed\n", a, c);
                return 1;
            }
            t_decomp += now_s() - t0;
            for (size_t i = 0; i < cn; i++) {
                int64_t want = hd_drop(x[off + i], drop_bits);
                if (dec[i] != want) {
                    if (bad < 3)
                        fprintf(stderr, "axis %u chunk %zu sample %zu: "
                                "decoded %lld want %lld\n", a, c, i,
                                (long long)dec[i], (long long)want);
                    bad++;
                }
                int64_t recon = (int64_t)((uint64_t)want << drop_bits);
                int64_t e = x[off + i] - recon;
                uint64_t ae = (uint64_t)(e < 0 ? -e : e);
                if (ae > max_err) max_err = ae;
                sum_err += ae;
            }
        }
        total_payload += axis_payload;
        printf("axis %u: payload %8zu B (%.3f bits/sample) table %6zu B\n",
               a, axis_payload, 8.0 * axis_payload / (double)n,
               hd_table_bytes(&table));
    }

    double mb = (double)n * 2.0 * axes / 1048576.0;      /* int16 bytes */
    printf("\nsummary\n");
    printf("  chunks          : %zu per axis, %u axes | round-trip %s\n",
           nchunks, axes, bad ? "FAILED" : "verified OK (quantized domain)");
    printf("  error           : max %llu LSB (bound %d) | mean %.4Lf LSB\n",
           (unsigned long long)max_err,
           drop_bits ? (1 << (drop_bits - 1)) : 0,
           sum_err / ((long double)n * axes));
    printf("  table           : %zu B total amortised | %zu B/axis\n",
           total_table, total_table / axes);
    printf("  payload+table   : %zu B | %.3f bits/sample | CR %.4f\n",
           total_payload + total_table,
           8.0 * (double)(total_payload + total_table) / ((double)n * axes),
           (double)(total_payload + total_table) / ((double)n * axes * 2.0));
    printf("  throughput      : compress %.1f MB/s (incl. training), "
           "decode %.1f MB/s\n",
           mb / (t_comp + t_train), mb / t_decomp);
    printf("  memory          : host table struct %.1f KiB (runtime: code LUT "
           "%u B + lengths %u B, training scratch %u B)\n",
           sizeof(hd_table) / 1024.0,
           (unsigned)(2u * K + 2u) * (unsigned)sizeof(uint64_t), 2u * K + 2u,
           (unsigned)(2 * K + 2) * 4);
    printf("  reference (same capture, delta+drop4): RLE-GEF 5.14 b/s "
           "(CR 0.3209), v24 delta+Rice ~5.1 b/s\n");

    free(buf); free(dec); free(x);
    fclose(f);
    return bad ? 1 : 0;
}
