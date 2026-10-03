/* BitBench example compressor: delta + zigzag LEB128 (C).
 * See docs/user-compressors.md for the package and output contract. */
#define _POSIX_C_SOURCE 200809L

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define NAME "example_delta_c"

static const char *CSV_HEADER =
    "compressor,dataset,num_values,original_size,memory_usage,"
    "uncompressed_bits,compressed_bits,compression_ratio,"
    "compression_throughput_mbs,decompression_throughput_mbs,"
    "random_access_ns,random_access_mbs";

typedef struct {
    char mode[16];
    int verify;
} Options;

static double now_seconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static uint64_t zigzag_encode(int64_t value) {
    return ((uint64_t)value << 1) ^ (uint64_t)(value >> 63);
}

static int64_t zigzag_decode(uint64_t value) {
    return (int64_t)(value >> 1) ^ -(int64_t)(value & 1);
}

static size_t write_varint(uint8_t *out, uint64_t value) {
    size_t written = 0;
    while (value >= 0x80) {
        out[written++] = (uint8_t)(value | 0x80);
        value >>= 7;
    }
    out[written++] = (uint8_t)value;
    return written;
}

static uint64_t read_varint(const uint8_t *in, size_t *index) {
    uint64_t result = 0;
    int shift = 0;
    for (;;) {
        uint8_t byte = in[(*index)++];
        result |= (uint64_t)(byte & 0x7F) << shift;
        if ((byte & 0x80) == 0) {
            return result;
        }
        shift += 7;
    }
}

/* Reads a whole file into memory. Caller frees. */
static char *read_file(const char *path, size_t *size_out) {
    FILE *file = fopen(path, "rb");
    if (!file) {
        return NULL;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return NULL;
    }
    long end = ftell(file);
    rewind(file);
    if (end < 0) {
        fclose(file);
        return NULL;
    }
    char *data = (char *)malloc((size_t)end + 1);
    if (!data) {
        fclose(file);
        return NULL;
    }
    size_t read = fread(data, 1, (size_t)end, file);
    fclose(file);
    data[read] = '\0';
    if (size_out) {
        *size_out = read;
    }
    return data;
}

/* Minimal JSON scan for the two example options: the JSON file takes
 * precedence over the CLI flags. */
static void apply_json_options(const char *path, Options *opts) {
    size_t size = 0;
    char *json = read_file(path, &size);
    if (!json) {
        return;
    }

    char *mode = strstr(json, "\"mode\"");
    if (mode) {
        char *colon = strchr(mode, ':');
        char *quote = colon ? strchr(colon, '"') : NULL;
        if (quote) {
            char *end = strchr(quote + 1, '"');
            if (end) {
                size_t length = (size_t)(end - quote - 1);
                if (length >= sizeof(opts->mode)) {
                    length = sizeof(opts->mode) - 1;
                }
                memcpy(opts->mode, quote + 1, length);
                opts->mode[length] = '\0';
            }
        }
    }

    char *verify = strstr(json, "\"verify\"");
    if (verify) {
        char *colon = strchr(verify, ':');
        if (colon) {
            opts->verify = strncmp(colon + 1, " true", 5) == 0 || strncmp(colon + 1, "true", 4) == 0;
        }
    }

    free(json);
}

static int read_bin(const char *path, int64_t **values_out, size_t *count_out, size_t *file_size_out) {
    size_t file_size = 0;
    char *raw = read_file(path, &file_size);
    if (!raw || file_size < 8) {
        free(raw);
        return -1;
    }

    uint64_t count = 0;
    memcpy(&count, raw, 8);
    size_t offset = 8;
    if (file_size == 16 + count * 8) {
        offset = 16;
    } else if (file_size != 8 + count * 8) {
        free(raw);
        return -1;
    }

    int64_t *values = NULL;
    if (count > 0) {
        values = (int64_t *)malloc(count * 8);
        if (!values) {
            free(raw);
            return -1;
        }
        memcpy(values, raw + offset, count * 8);
    }

    free(raw);
    *values_out = values;
    *count_out = (size_t)count;
    *file_size_out = file_size;
    return 0;
}

int main(int argc, char **argv) {
    Options opts = {"delta", 1};
    const char *out_path = NULL;
    const char *in_path = NULL;
    const char *options_path = NULL;

    for (int i = 1; i < argc; ++i) {
        const char *arg = argv[i];
        if (strcmp(arg, "-o") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(arg, "--options") == 0 && i + 1 < argc) {
            options_path = argv[++i];
        } else if (strncmp(arg, "--mode=", 7) == 0) {
            snprintf(opts.mode, sizeof(opts.mode), "%s", arg + 7);
        } else if (strncmp(arg, "--verify=", 9) == 0) {
            opts.verify = strcmp(arg + 9, "true") == 0;
        } else if (arg[0] != '-') {
            in_path = arg;
        }
    }

    if (options_path) {
        apply_json_options(options_path, &opts);
    }
    if (!out_path || !in_path) {
        fprintf(stderr, "usage: codec -o <out.csv> [--options <opts.json>] <input.bin>\n");
        return 1;
    }

    int64_t *values = NULL;
    size_t count = 0;
    size_t file_size = 0;
    if (read_bin(in_path, &values, &count, &file_size) != 0) {
        fprintf(stderr, "cannot read input %s\n", in_path);
        free(values);
        return 1;
    }

    uint8_t *compressed = (uint8_t *)malloc(count * 10 + 16);
    if (!compressed) {
        free(values);
        return 1;
    }

    double started = now_seconds();
    size_t compressed_size = 0;
    int64_t previous = 0;
    for (size_t i = 0; i < count; ++i) {
        int64_t delta = strcmp(opts.mode, "raw") == 0 ? values[i] : values[i] - previous;
        previous = values[i];
        compressed_size += write_varint(compressed + compressed_size, zigzag_encode(delta));
    }
    double compressed_at = now_seconds();

    if (opts.verify) {
        size_t index = 0;
        previous = 0;
        for (size_t i = 0; i < count; ++i) {
            int64_t delta = zigzag_decode(read_varint(compressed, &index));
            int64_t value = strcmp(opts.mode, "raw") == 0 ? delta : previous + delta;
            if (value != values[i]) {
                fprintf(stderr, "round-trip verification failed at %zu\n", i);
                free(compressed);
                free(values);
                return 1;
            }
            previous = value;
        }
    }
    double verified_at = now_seconds();

    size_t original_size = count * 8;
    size_t uncompressed_bits = count * 64;
    size_t compressed_bits = compressed_size * 8;
    double ratio = uncompressed_bits ? (double)compressed_bits / (double)uncompressed_bits : 0.0;
    double compress_mbs = compressed_at > started
        ? ((double)original_size / 1048576.0) / (compressed_at - started) : 0.0;
    double decompress_mbs = verified_at > compressed_at
        ? ((double)original_size / 1048576.0) / (verified_at - compressed_at) : 0.0;

    FILE *out = fopen(out_path, "w");
    if (!out) {
        free(compressed);
        free(values);
        return 1;
    }
    fprintf(out, "%s\n", CSV_HEADER);
    fprintf(out, "%s,example,%zu,%zu,,%zu,%zu,%.6f,%.3f,%.3f,,\n",
            NAME, count, original_size, uncompressed_bits, compressed_bits,
            ratio, compress_mbs, decompress_mbs);
    fclose(out);

    free(compressed);
    free(values);
    return 0;
}
