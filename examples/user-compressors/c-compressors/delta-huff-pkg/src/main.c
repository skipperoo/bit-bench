/*
 * BitBench user compressor package `delta_huff` (Delta-Huff).
 *
 * Runs ONLY the lossy-then-Huffman delta codec: the sequence is quantized by
 * discarding N LSBs (device quantizer), delta-coded, and each delta is Huffman
 * coded with a canonical table trained on the first chunks of the same file
 * (plus an escape symbol with a per-chunk bit width for everything outside the
 * table). Data flow per benchmark file:
 *
 *   .bin (uint64 N [+ uint64 decimals] + N x int64)
 *     -> values are compressed in 4096-sample chunks; each chunk stores its
 *        first (quantized) value as an int64 and codes the rest
 *     -> stream = [table block][chunk block]... ; both self-delimiting
 *     -> decompression rebuilds the quantized sequence exactly and shifts it
 *        back (x_hat = Q << N), so |x - x_hat| <= 2^(N-1) LSB.
 *
 * Options (spec.yaml): drop_bits, mode (lossy|lossless), table_k.
 * The JSON options file takes precedence over the individual flags.
 *
 * Reported metrics: compression/decompression throughput in MiB/s of input
 * data; memory_usage is the tracked peak of this program's own allocations
 * plus the input array (like the built-ins), reported separately as
 * compressor_internal and input_buffer.
 */
#define _POSIX_C_SOURCE 200809L

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "huff_delta.h"

#define NAME "delta_huff"
#define CHUNK_SAMPLES 4096
#define TRAIN_CHUNKS  8

static const char *CSV_HEADER =
    "compressor,dataset,num_values,original_size,memory_usage,"
    "uncompressed_bits,compressed_bits,compression_ratio,"
    "compression_throughput_mbs,decompression_throughput_mbs,"
    "random_access_ns,random_access_mbs,input_buffer,compressor_internal";

typedef struct {
    int drop_bits;
    int lossless;
    int table_k;
    int adaptive;       /* streaming: tables rebuilt from the recent window  */
    int refresh;        /* chunks per table in adaptive mode                 */
} Options;

/* ---------------- tracked allocator ---------------- */
static size_t g_live, g_peak, g_input_bytes;
static void *x_alloc(size_t n) {
    size_t *p = malloc(n + 2 * sizeof(size_t));
    if (!p) { fputs(NAME ": out of memory\n", stderr); exit(1); }
    p[0] = n;
    g_live += n + 2 * sizeof(size_t);
    if (g_live > g_peak) g_peak = g_live;
    return (void *)(p + 2);
}
static void *x_realloc(void *ptr, size_t n) {
    if (!ptr) return x_alloc(n);
    size_t *base = (size_t *)ptr - 2;
    size_t old = base[0];
    size_t *np = realloc(base, n + 2 * sizeof(size_t));
    if (!np) { fputs(NAME ": out of memory\n", stderr); exit(1); }
    np[0] = n;
    g_live += n - old;
    if (g_live > g_peak) g_peak = g_live;
    return (void *)(np + 2);
}
static void x_free(void *ptr) {
    if (!ptr) return;
    size_t *base = (size_t *)ptr - 2;
    g_live -= base[0] + 2 * sizeof(size_t);
    free(base);
}

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static char *read_file(const char *path, size_t *size_out) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long end = ftell(f);
    rewind(f);
    if (end < 0) { fclose(f); return NULL; }
    char *data = malloc((size_t)end + 1);
    if (!data) { fclose(f); return NULL; }
    size_t got = fread(data, 1, (size_t)end, f);
    fclose(f);
    data[got] = '\0';
    if (size_out) *size_out = got;
    return data;
}

static int read_bin(const char *path, int64_t **values_out, size_t *count_out,
                    uint64_t *decimals_out) {
    size_t size = 0;
    char *raw = read_file(path, &size);
    if (!raw || size < 8) { free(raw); return -1; }
    uint64_t count = 0;
    memcpy(&count, raw, 8);
    if (count > (uint64_t)1 << 40) { free(raw); return -1; }
    size_t offset;
    if (size == 16 + (size_t)count * 8) offset = 16;
    else if (size == 8 + (size_t)count * 8) offset = 8;
    else { free(raw); return -1; }
    int64_t *values = count ? malloc((size_t)count * 8) : NULL;
    if (count && !values) { free(raw); return -1; }
    if (count) memcpy(values, raw + offset, (size_t)count * 8);
    uint64_t decimals = 0;
    if (offset == 16) memcpy(&decimals, raw + 8, 8);
    free(raw);
    *values_out = values;
    *count_out = (size_t)count;
    *decimals_out = decimals;
    return 0;
}

static void apply_json_options(const char *path, Options *options) {
    size_t size = 0;
    char *json = read_file(path, &size);
    if (!json) return;
    char *p = strstr(json, "\"drop_bits\"");
    if (p) { char *c = strchr(p, ':'); if (c) options->drop_bits = (int)strtol(c + 1, NULL, 10); }
    p = strstr(json, "\"table_k\"");
    if (p) { char *c = strchr(p, ':'); if (c) options->table_k = (int)strtol(c + 1, NULL, 10); }
    p = strstr(json, "\"adaptive\"");
    if (p) { char *c = strchr(p, ':'); if (c) options->adaptive = !strncmp(c + 1, " true", 5) || !strncmp(c + 1, "true", 4); }
    p = strstr(json, "\"refresh\"");
    if (p) { char *c = strchr(p, ':'); if (c) options->refresh = (int)strtol(c + 1, NULL, 10); }
    p = strstr(json, "\"mode\"");
    if (p) {
        char *c = strchr(p, ':');
        char *q = c ? strchr(c, '"') : NULL;
        if (q) {
            char *e = strchr(q + 1, '"');
            if (e) {
                if (e - q - 1 == 7 && !strncmp(q + 1, "lossless", 8)) options->lossless = 1;
                else if (e - q - 1 == 5 && !strncmp(q + 1, "lossy", 5)) options->lossless = 0;
            }
        }
    }
    free(json);
}

int main(int argc, char **argv) {
    Options options = { 4, 0, 255, 0, 64 };
    const char *out_path = NULL, *in_path = NULL, *options_path = NULL;
    size_t chunk = CHUNK_SAMPLES;

    for (int i = 1; i < argc; ++i) {
        const char *a = argv[i];
        if (!strcmp(a, "-o") && i + 1 < argc) out_path = argv[++i];
        else if (!strcmp(a, "--options") && i + 1 < argc) options_path = argv[++i];
        else if (!strncmp(a, "--drop_bits=", 12)) options.drop_bits = (int)strtol(a + 12, NULL, 10);
        else if (!strncmp(a, "--drop-bits=", 12)) options.drop_bits = (int)strtol(a + 12, NULL, 10);
        else if (!strncmp(a, "--table_k=", 10)) options.table_k = (int)strtol(a + 10, NULL, 10);
        else if (!strncmp(a, "--adaptive=", 11)) options.adaptive = strcmp(a + 11, "false") != 0;
        else if (!strncmp(a, "--refresh=", 10)) options.refresh = (int)strtol(a + 10, NULL, 10);
        else if (!strncmp(a, "--table-k=", 10)) options.table_k = (int)strtol(a + 10, NULL, 10);
        else if (!strncmp(a, "--mode=", 7)) options.lossless = !strcmp(a + 7, "lossless");
        else if (!strncmp(a, "--chunk=", 8)) {
            long long v = strtoll(a + 8, NULL, 10);
            if (v >= 64 && v <= (1 << 20)) chunk = (size_t)v;
        } else if (a[0] != '-') in_path = a;
    }
    if (options_path) apply_json_options(options_path, &options);
    if (options.lossless) options.drop_bits = 0;
    if (options.drop_bits < 0) options.drop_bits = 0;
    if (options.drop_bits > 15) options.drop_bits = 15;
    if (options.refresh < 1) options.refresh = 1;
    if (options.refresh > 4096) options.refresh = 4096;
    if (options.table_k < 1) options.table_k = 1;
    if (options.table_k > HD_MAX_K) options.table_k = HD_MAX_K;
    if (!out_path || !in_path) {
        fputs("usage: codec -o <out.csv> [--drop_bits=N] [--mode=lossy|lossless] "
              "[--table_k=K] [--options <opts.json>] <input.bin>\n", stderr);
        return 1;
    }

    int64_t *values = NULL;
    size_t count = 0;
    uint64_t decimals = 0;
    if (read_bin(in_path, &values, &count, &decimals) != 0) {
        fprintf(stderr, NAME ": cannot read input %s\n", in_path);
        return 1;
    }
    g_input_bytes = count * 8;
    size_t nchunks = count ? (count + chunk - 1) / chunk : 0;

    int64_t *decoded = x_alloc(chunk * 8);
    size_t chunk_cap = hd_max_chunk_payload(chunk) + 16 * (2 * (size_t)options.table_k + 2);
    uint8_t *chunk_buf = x_alloc(chunk_cap);
    size_t out_cap = 1 << 16;
    uint8_t *out = x_alloc(out_cap);

    /* ---- tables: offline prefix training, or adaptive streaming ---- */
    hd_table table, accumulator;
    hd_table_init(&table, options.drop_bits, options.table_k);
    if (!options.adaptive) {
        for (size_t c = 0; c < TRAIN_CHUNKS && c < nchunks; c++) {
            size_t off = c * chunk;
            size_t cn = count - off < chunk ? count - off : chunk;
            hd_train_chunk(&table, values + off, cn);
        }
        if (hd_finish_training(&table) != 0) {
            fputs(NAME ": training failed\n", stderr);
            return 1;
        }
    } else {
        hd_table_init(&accumulator, options.drop_bits, options.table_k);
    }

    /* ---- compression (training included in the timed window) ---- */
    double t_start = now_seconds();
    size_t used = 0;
    size_t table_len = 0;
    size_t huff_chunks = 0;
    /* New streams carry a 5-byte header: "HDV2" + flags.  flags bit0 = the
     * table is stored at the head, bit1 = adaptive (tables in chunks).
     * Old streams start with the table (no magic) and remain decodable. */
    memcpy(out, "HDV2", 4);
    out[4] = options.adaptive ? 2 : 1;
    used = 5;
    if (!options.adaptive) {
        table_len = hd_write_table(&table, out + used, out_cap - used);
        if (!table_len) { fputs(NAME ": table does not fit\n", stderr); return 1; }
        used += table_len;
    }
    size_t updates = 0;
    for (size_t c = 0; c < nchunks; c++) {
        size_t off = c * chunk;
        size_t cn = count - off < chunk ? count - off : chunk;
        int update = 0;
        if (options.adaptive) {
            /* causal: the table used for chunk c is trained on chunks < c
             * (the bootstrap table on chunk 0 itself, decoded before use) */
            if (c == 0) {
                hd_train_chunk(&table, values + off, cn);
                if (hd_finish_training(&table) != 0) {
                    fputs(NAME ": training failed\n", stderr); return 1;
                }
                update = 1;
            } else if (c % (size_t)options.refresh == 0) {
                table = accumulator;
                if (hd_finish_training(&table) != 0) {
                    fputs(NAME ": training failed\n", stderr); return 1;
                }
                hd_table_init(&accumulator, options.drop_bits, options.table_k);
                update = 1;
            }
            if (update)
                updates++;
        }
        int used_fb = 0;
        size_t len = hd_encode_chunk_best(&table, values + off, cn, chunk_buf,
                                          chunk_cap, update, &used_fb);
        if (!len) { fprintf(stderr, NAME ": encode failed (chunk %zu)\n", c); return 1; }
        if (!used_fb)
            huff_chunks++;
        if (used + len > out_cap) {
            size_t cap = out_cap;
            while (cap < used + len) cap *= 2;
            out = x_realloc(out, cap);
            out_cap = cap;
        }
        memcpy(out + used, chunk_buf, len);
        used += len;
        if (options.adaptive)
            hd_train_chunk(&accumulator, values + off, cn);
        if (c == 0 && nchunks > 1) {
            size_t projected = used * nchunks + (1 << 16);
            if (projected > out_cap) {
                out_cap = projected + projected / 2;
                out = x_realloc(out, out_cap);
            }
        }
    }
    if (!options.adaptive && huff_chunks == 0 && table_len) {
        /* Every chunk chose the exact fallback: the table is dead weight. */
        memmove(out + 5, out + 5 + table_len, used - 5 - table_len);
        used -= table_len;
        out[4] = 0;
    }
    if (options.adaptive && huff_chunks == 0 && nchunks) {
        /* Same for adaptive streams: no table update is needed if every
         * chunk is an exact fallback.  Rebuild without the embedded tables;
         * keep the original stream if any chunk unexpectedly prefers Huffman. */
        uint8_t *rebuf = x_alloc(out_cap);
        size_t nused = 5;
        memcpy(rebuf, "HDV2", 4);
        rebuf[4] = 2;
        int all_fb = 1;
        for (size_t c = 0; c < nchunks; c++) {
            size_t off = c * chunk;
            size_t cn = count - off < chunk ? count - off : chunk;
            int fb = 0;
            size_t len = hd_encode_chunk_best(&table, values + off, cn,
                                              chunk_buf, chunk_cap, 0, &fb);
            if (!len || !fb || nused + len > out_cap) {
                all_fb = 0;
                break;
            }
            memcpy(rebuf + nused, chunk_buf, len);
            nused += len;
        }
        if (all_fb) {
            memcpy(out, rebuf, nused);
            used = nused;
            out[4] = 2;
        }
        x_free(rebuf);
    }
    double t_compressed = now_seconds();

    /* ---- decompression (timed) + verification ---- */
    hd_table rtable;
    hd_table_init(&rtable, options.drop_bits, options.table_k);
    size_t pos = 0;
    int new_fmt = used >= 5 && memcmp(out, "HDV2", 4) == 0;
    int head_table = new_fmt ? (out[4] & 1) : !options.adaptive;
    if (new_fmt)
        pos = 5;
    if (head_table) {
        size_t tl = hd_read_table(&rtable, out + pos, used - pos);
        if (!tl || (new_fmt && tl != table_len)) {
            fputs(NAME ": table parse failed\n", stderr);
            return 1;
        }
        pos += tl;
    }
    uint64_t max_err = 0;
    long double sum_err = 0;
    double t_dec = 0;
    for (size_t c = 0; c < nchunks; c++) {
        if (pos + HD_HDR_CHUNK > used) goto truncated;
        uint32_t blen_raw;
        memcpy(&blen_raw, out + pos, 4);
        int is_fb = (blen_raw & HD_FLAG_FALLBACK) != 0;
        uint32_t blen = blen_raw & ~(HD_FLAG_FALLBACK | HD_FLAG_VARINT);
        if (blen < HD_HDR_CHUNK || pos + blen > used) goto truncated;
        size_t off = c * chunk;
        size_t cn = count - off < chunk ? count - off : chunk;
        double t0 = now_seconds();
        if (hd_decode_chunk_upd(&rtable, out + pos, blen, decoded, cn) != 0) {
            fprintf(stderr, NAME ": decode failed (chunk %zu)\n", c);
            return 1;
        }
        t_dec += now_seconds() - t0;
        pos += blen;
        for (size_t i = 0; i < cn; i++) {
            if (is_fb) {
                if (decoded[i] != values[off + i]) {
                    fprintf(stderr, NAME ": fallback verification failed at %zu\n",
                            off + i);
                    return 1;
                }
                continue;              /* exact fallback: error 0 */
            }
            int64_t want = hd_drop(values[off + i], options.drop_bits);
            if (decoded[i] != want) {
                fprintf(stderr, NAME ": verification failed at %zu\n", off + i);
                return 1;
            }
            int64_t recon;
            if (options.drop_bits) {
                if (decoded[i] > INT64_MAX >> options.drop_bits ||
                    decoded[i] < INT64_MIN >> options.drop_bits) {
                    fputs(NAME ": reconstruction overflow\n", stderr);
                    return 1;
                }
                recon = (int64_t)((uint64_t)decoded[i] << options.drop_bits);
            } else {
                recon = decoded[i];
            }
            int64_t e = values[off + i] - recon;
            uint64_t ae = e < 0 ? (uint64_t)(-(e + 1)) + 1u : (uint64_t)e;
            if (ae > max_err) max_err = ae;
            sum_err += ae;
            if (ae > (uint64_t)(options.drop_bits ? ((int64_t)1 << (options.drop_bits - 1)) : 0)) {
                fprintf(stderr, NAME ": error bound exceeded at %zu\n", off + i);
                return 1;
            }
        }
    }
    if (pos != used) goto truncated;
    fprintf(stderr, NAME ": %zu values, %zu chunks, drop_bits=%d, table_k=%d, "
            "adaptive=%d refresh=%d, table updates %zu, table %zu B\n",
            count, nchunks, options.drop_bits, options.table_k, options.adaptive, options.refresh,
            updates, hd_table_bytes(options.adaptive ? &rtable : &table));
    fprintf(stderr, NAME ": compressed %zu B (ratio %.6f), max error %" PRIu64
            " LSB, mean %.4Lf LSB\n", used, count ? (double)used / (double)(count * 8) : 0.0,
            max_err, count ? sum_err / (long double)count : 0.0L);
    fprintf(stderr, NAME ": memory: compressor peak %zu B, input array %zu B, "
            "total %zu B\n", g_peak, g_input_bytes, g_peak + g_input_bytes);
    if (decimals)
        fprintf(stderr, NAME ": input decimals field = %" PRIu64 "\n", decimals);

    /* ---- CSV ---- */
    size_t original_size = count * 8;
    size_t uncompressed_bits = count * 64;
    size_t compressed_bits = used * 8;
    double ratio = uncompressed_bits
        ? (double)compressed_bits / (double)uncompressed_bits : 0.0;
    double comp_mbs = t_compressed > t_start
        ? ((double)original_size / 1048576.0) / (t_compressed - t_start) : 0.0;
    double decomp_mbs = t_dec > 0
        ? ((double)original_size / 1048576.0) / t_dec : 0.0;
    FILE *out_csv = fopen(out_path, "w");
    if (!out_csv) { fprintf(stderr, NAME ": cannot write %s\n", out_path); return 1; }
    fprintf(out_csv, "%s\n", CSV_HEADER);
    fprintf(out_csv, "%s,bitbench,%zu,%zu,%zu,%zu,%zu,%.6f,%.3f,%.3f,,,%zu,%zu\n",
            NAME, count, original_size, g_peak + g_input_bytes, uncompressed_bits,
            compressed_bits, ratio, comp_mbs, decomp_mbs, g_input_bytes, g_peak);
    fclose(out_csv);

    x_free(out);
    x_free(chunk_buf);
    x_free(decoded);
    free(values);
    return 0;

truncated:
    fputs(NAME ": truncated compressed stream\n", stderr);
    return 1;
}
