/*
 * rle_gef.c — see rle_gef.h. Integer-only, no stdio, allocator hooks only.
 *
 * Port of the C++ RLE_GEF (reference/generalized-elias-fano) trimmed for
 * MCU streaming use:
 *   - no rank/select index, no random access: get/get_elements walk the run
 *     boundary vector from the start (O(index) when starting mid-sequence);
 *   - no temporary shifted array: the split point is computed with one LCP
 *     histogram pass over the input (see rle_gef_build);
 *   - chunks are packed to/from caller memory.
 *
 * The compressed bit layout is identical to the original C port (LSB-first
 * packing, low_bits/high_bits/base semantics, same optimal-low_bits cost
 * model).
 */
#include "rle_gef.h"

#include <stdlib.h>
#include <string.h>

/* =========================================================================
 * packed unsigned integer vector
 * ========================================================================= */

static void packed_vector_init(rle_gef_packed_vector *vector, size_t length,
                               uint8_t bit_width) {
    vector->length = length;
    vector->bit_width = bit_width;
    if (length == 0 || bit_width == 0) {
        vector->words = NULL;
        vector->word_capacity = 0;
        return;
    }
    size_t total_bits = length * (size_t)bit_width;
    vector->word_capacity = (total_bits + 63) / 64;
    vector->words = RGEF_CALLOC(vector->word_capacity, sizeof(uint64_t));
}

static void packed_vector_destroy(rle_gef_packed_vector *vector) {
    RGEF_FREE(vector->words);
    vector->words = NULL;
    vector->length = 0;
    vector->word_capacity = 0;
    vector->bit_width = 0;
}

static uint64_t packed_vector_get(const rle_gef_packed_vector *vector,
                                  size_t index) {
    if (vector->bit_width == 0 || index >= vector->length)
        return 0;
    size_t bit_position = index * (size_t)vector->bit_width;
    size_t word_index = bit_position >> 6;
    uint32_t bit_offset = (uint32_t)(bit_position & 63);
    uint8_t width = vector->bit_width;

    uint64_t value;
    if (bit_offset + width <= 64) {
        value = vector->words[word_index] >> bit_offset;
    } else {
        uint32_t from_first_word = 64 - bit_offset;
        value = vector->words[word_index] >> bit_offset;
        value |= vector->words[word_index + 1] << from_first_word;
    }
    if (width < 64)
        value &= ((UINT64_C(1) << width) - 1);
    return value;
}

static void packed_vector_set(rle_gef_packed_vector *vector, size_t index,
                              uint64_t value) {
    if (vector->bit_width == 0 || index >= vector->length)
        return;
    uint8_t width = vector->bit_width;
    uint64_t value_mask = (width == 64) ? UINT64_MAX
                                        : ((UINT64_C(1) << width) - 1);
    value &= value_mask;

    size_t bit_position = index * (size_t)width;
    size_t word_index = bit_position >> 6;
    uint32_t bit_offset = (uint32_t)(bit_position & 63);

    uint64_t first_mask = value_mask << bit_offset;
    vector->words[word_index] =
        (vector->words[word_index] & ~first_mask) | (value << bit_offset);

    uint32_t from_first_word = 64 - bit_offset;
    if (width > from_first_word) {
        uint32_t remaining = width - from_first_word;
        uint64_t second_mask = (remaining == 64)
                             ? UINT64_MAX
                             : ((UINT64_C(1) << remaining) - 1);
        vector->words[word_index + 1] =
            (vector->words[word_index + 1] & ~second_mask) |
            (value >> from_first_word);
    }
}

static size_t packed_vector_bytes(const rle_gef_packed_vector *vector) {
    return vector->word_capacity * sizeof(uint64_t);
}

/* =========================================================================
 * bit vector (raw bits, LSB-first like the packed vector above)
 * ========================================================================= */

static void bit_vector_init(rle_gef_bit_vector *vector, size_t bit_count) {
    vector->bit_count = bit_count;
    if (bit_count == 0) {
        vector->words = NULL;
        return;
    }
    size_t word_count = (bit_count + 63) / 64;
    vector->words = RGEF_CALLOC(word_count, sizeof(uint64_t));
}

static void bit_vector_destroy(rle_gef_bit_vector *vector) {
    RGEF_FREE(vector->words);
    vector->words = NULL;
    vector->bit_count = 0;
}

static bool bit_vector_get(const rle_gef_bit_vector *vector, size_t index) {
    if (index >= vector->bit_count)
        return false;
    return (vector->words[index >> 6] >> (index & 63)) & 1ULL;
}

static void bit_vector_set(rle_gef_bit_vector *vector, size_t index,
                           bool value) {
    if (index >= vector->bit_count)
        return;
    if (value)
        vector->words[index >> 6] |= (UINT64_C(1) << (index & 63));
    else
        vector->words[index >> 6] &= ~(UINT64_C(1) << (index & 63));
}

static size_t bit_vector_bytes(const rle_gef_bit_vector *vector) {
    return ((vector->bit_count + 63) / 64) * sizeof(uint64_t);
}

/* =========================================================================
 * split point
 * ========================================================================= */

/* Longest common prefix of x and y represented on total_bits bits. */
static uint8_t lcp_u64(uint64_t x, uint64_t y, uint8_t total_bits) {
    if (x == y)
        return total_bits;
    int leading_zeros = __builtin_clzll(x ^ y);
    return (uint8_t)(leading_zeros - (64 - total_bits));
}

/*
 * Cost model (identical to the C++ original and the original C port):
 *   Space(S, b) = n*(b+1) + h*Rank_B(n),  Rank_B(n) = 1 + #{i : LCP(i) < h}
 * The histogram of LCP values turns the whole scan into Theta(n + log u):
 * rank_h is accumulated incrementally while h grows.
 */
static uint8_t optimal_split(const size_t *lcp_frequency, size_t n,
                             uint8_t total_bits) {
    size_t best_low_bits = total_bits;
    size_t best_space = (size_t)total_bits * n;
    size_t rank_h = 1;  /* B[0] is always 1: the first value starts a run */

    for (uint8_t high_bits = 1; high_bits <= total_bits; high_bits++) {
        uint8_t low_bits = total_bits - high_bits;
        rank_h += lcp_frequency[high_bits - 1];
        size_t space = n * ((size_t)low_bits + 1) +
                       rank_h * (size_t)high_bits;
        if (space < best_space) {
            best_space = space;
            best_low_bits = low_bits;
        }
    }
    return (uint8_t)best_low_bits;
}

/* =========================================================================
 * little-endian helpers for the packed blob
 * ========================================================================= */

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static void put_u16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static uint16_t get_u16(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static void put_u64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++)
        p[i] = (uint8_t)(v >> (8 * i));
}

static uint64_t get_u64(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++)
        v |= (uint64_t)p[i] << (8 * i);
    return v;
}

static size_t words_for(size_t bits) { return (bits + 63) / 64; }

/* =========================================================================
 * RLE-GEF type instantiations
 * ========================================================================= */

/*
 * Granularity note: the algorithm works on unsigned U of the same width as
 * T (uint8_t / uint16_t); shifted = (U)(data[i] - base) wraps modulo 2^bits,
 * which is exactly the value range [0, max - min].
 */
#define RLE_GEF_IMPL(Suffix, T, U)                                             \
                                                                               \
void rle_gef_##Suffix##_init(rle_gef_##Suffix *rle) {                          \
    memset(rle, 0, sizeof(*rle));                                              \
}                                                                              \
                                                                               \
void rle_gef_##Suffix##_destroy(rle_gef_##Suffix *rle) {                       \
    bit_vector_destroy(&rle->run_boundaries);                                  \
    packed_vector_destroy(&rle->run_values);                                   \
    packed_vector_destroy(&rle->low_parts);                                    \
    memset(rle, 0, sizeof(*rle));                                              \
}                                                                              \
                                                                               \
static uint64_t rle_gef_##Suffix##_shift(const T *samples, size_t index,       \
                                         T base) {                             \
    return (uint64_t)(U)((U)samples[index] - (U)base);                         \
}                                                                              \
                                                                               \
int rle_gef_##Suffix##_build(rle_gef_##Suffix *rle, const T *samples,          \
                             size_t n) {                                       \
    rle_gef_##Suffix##_init(rle);                                              \
    if (n == 0)                                                                \
        return 0;                                                              \
                                                                               \
    /* pass 1: minimum (base) and shifted maximum (universe width)          */ \
    T minimum = samples[0];                                                    \
    for (size_t i = 1; i < n; i++)                                             \
        if (samples[i] < minimum)                                              \
            minimum = samples[i];                                              \
    uint64_t maximum_shift = 0;                                                \
    for (size_t i = 0; i < n; i++) {                                           \
        uint64_t shifted = rle_gef_##Suffix##_shift(samples, i, minimum);      \
        if (shifted > maximum_shift)                                           \
            maximum_shift = shifted;                                           \
    }                                                                          \
    uint8_t total_bits = maximum_shift                                          \
        ? (uint8_t)(64 - __builtin_clzll(maximum_shift))                       \
        : 1;                                                                   \
                                                                               \
    /* pass 2: LCP histogram (no temporary array) */                           \
    size_t lcp_frequency[65];                                                  \
    memset(lcp_frequency, 0, sizeof lcp_frequency);                            \
    for (size_t i = 1; i < n; i++) {                                           \
        uint64_t current = rle_gef_##Suffix##_shift(samples, i, minimum);      \
        uint64_t previous = rle_gef_##Suffix##_shift(samples, i - 1, minimum); \
        lcp_frequency[lcp_u64(current, previous, total_bits)]++;               \
    }                                                                          \
                                                                               \
    rle->base = minimum;                                                       \
    rle->sample_count = n;                                                     \
    rle->low_bits = optimal_split(lcp_frequency, n, total_bits);               \
    rle->high_bits = (uint8_t)(total_bits - rle->low_bits);                    \
    uint8_t low_bits = rle->low_bits;                                          \
    uint8_t high_bits = rle->high_bits;                                        \
                                                                               \
    if (low_bits > 0) {                                                        \
        packed_vector_init(&rle->low_parts, n, low_bits);                      \
        if (!rle->low_parts.words) {                                           \
            rle_gef_##Suffix##_destroy(rle);                                   \
            return -1;                                                         \
        }                                                                      \
    }                                                                          \
                                                                               \
    if (high_bits == 0) {                                                      \
        for (size_t i = 0; i < n; i++)                                         \
            packed_vector_set(&rle->low_parts, i,                              \
                              rle_gef_##Suffix##_shift(samples, i, minimum));   \
        return 0;                                                              \
    }                                                                          \
                                                                               \
    /* pass 3: run boundaries + low parts, counting the runs */                \
    bit_vector_init(&rle->run_boundaries, n);                                  \
    if (!rle->run_boundaries.words) {                                          \
        rle_gef_##Suffix##_destroy(rle);                                       \
        return -1;                                                             \
    }                                                                          \
    uint64_t low_mask = (low_bits > 0)                                         \
        ? ((UINT64_C(1) << low_bits) - 1) : 0;                                 \
    uint64_t last_high = 0;                                                    \
    size_t run_count = 0;                                                      \
    for (size_t i = 0; i < n; i++) {                                           \
        uint64_t shifted = rle_gef_##Suffix##_shift(samples, i, minimum);      \
        uint64_t high = shifted >> low_bits;                                   \
        if (low_bits > 0)                                                      \
            packed_vector_set(&rle->low_parts, i, shifted & low_mask);         \
        if (i == 0 || high != last_high) {                                     \
            bit_vector_set(&rle->run_boundaries, i, true);                     \
            run_count++;                                                       \
        }                                                                      \
        last_high = high;                                                      \
    }                                                                          \
                                                                               \
    /* pass 4: one high part per run */                                        \
    packed_vector_init(&rle->run_values, run_count, high_bits);                \
    if (!rle->run_values.words) {                                              \
        rle_gef_##Suffix##_destroy(rle);                                       \
        return -1;                                                             \
    }                                                                          \
    last_high = 0;                                                             \
    size_t run_index = 0;                                                      \
    for (size_t i = 0; i < n; i++) {                                           \
        uint64_t shifted = rle_gef_##Suffix##_shift(samples, i, minimum);      \
        uint64_t high = shifted >> low_bits;                                   \
        if (i == 0 || high != last_high)                                       \
            packed_vector_set(&rle->run_values, run_index++, high);            \
        last_high = high;                                                      \
    }                                                                          \
    return 0;                                                                  \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_get_elements(const rle_gef_##Suffix *rle,            \
                                       size_t start, size_t count, T *out) {   \
    if (!rle || count == 0 || start >= rle->sample_count)                      \
        return 0;                                                              \
    size_t end = start + count;                                                \
    if (end > rle->sample_count)                                               \
        end = rle->sample_count;                                               \
    size_t produced = 0;                                                       \
                                                                               \
    if (rle->high_bits == 0) {                                                 \
        if (rle->low_bits == 0) {                                              \
            for (size_t i = start; i < end; i++)                               \
                out[produced++] = rle->base;                                   \
        } else {                                                               \
            for (size_t i = start; i < end; i++)                               \
                out[produced++] =                                              \
                    (T)((U)rle->base +                                         \
                        (U)packed_vector_get(&rle->low_parts, i));             \
        }                                                                      \
        return produced;                                                       \
    }                                                                          \
                                                                               \
    /* walk the boundary vector from the start, keeping the current high    */ \
    /* part of the run */                                                      \
    size_t run_index = 0;                                                      \
    uint64_t current_high = 0;                                                 \
    for (size_t i = 0; i < end; i++) {                                         \
        if (bit_vector_get(&rle->run_boundaries, i))                           \
            current_high = packed_vector_get(&rle->run_values, run_index++);   \
        if (i >= start) {                                                      \
            uint64_t low = rle->low_bits                                       \
                ? packed_vector_get(&rle->low_parts, i) : 0;                   \
            out[produced++] = (T)((U)rle->base +                               \
                                  (U)(low | (current_high << rle->low_bits))); \
        }                                                                      \
    }                                                                          \
    return produced;                                                           \
}                                                                              \
                                                                               \
T rle_gef_##Suffix##_get(const rle_gef_##Suffix *rle, size_t index) {          \
    T value = 0;                                                               \
    if (rle_gef_##Suffix##_get_elements(rle, index, 1, &value) != 1)           \
        return 0;                                                              \
    return value;                                                              \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_size(const rle_gef_##Suffix *rle) {                  \
    return rle->sample_count;                                                  \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_size_in_bytes(const rle_gef_##Suffix *rle) {         \
    return bit_vector_bytes(&rle->run_boundaries) +                            \
           packed_vector_bytes(&rle->run_values) +                             \
           packed_vector_bytes(&rle->low_parts) +                              \
           sizeof(uint8_t) * 2 + sizeof(size_t) + sizeof(T);                   \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_packed_bits(const rle_gef_##Suffix *rle) {           \
    size_t bits = rle->low_parts.length * rle->low_bits;                       \
    if (rle->high_bits > 0)                                                    \
        bits += rle->run_boundaries.bit_count +                                \
                rle->run_values.length * rle->high_bits;                       \
    return bits;                                                               \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_runs(const rle_gef_##Suffix *rle) {                  \
    return rle->high_bits > 0 ? rle->run_values.length : 0;                    \
}                                                                              \
                                                                               \
uint8_t rle_gef_##Suffix##_split_point(const rle_gef_##Suffix *rle) {          \
    return rle->low_bits;                                                      \
}                                                                              \
                                                                               \
uint8_t rle_gef_##Suffix##_high_bits(const rle_gef_##Suffix *rle) {            \
    return rle->high_bits;                                                     \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_blob_size(const rle_gef_##Suffix *rle) {             \
    size_t bytes = RLE_GEF_BLOB_HEADER_BYTES;                                  \
    if (rle->high_bits > 0)                                                    \
        bytes += words_for(rle->run_boundaries.bit_count) * 8;                 \
    bytes += words_for((size_t)rle->run_values.length * rle->high_bits) * 8;   \
    bytes += words_for((size_t)rle->low_parts.length * rle->low_bits) * 8;     \
    return bytes;                                                              \
}                                                                              \
                                                                               \
size_t rle_gef_##Suffix##_blob_size_max(size_t n) {                            \
    /* worst case low_bits = high_bits = bits(T): boundaries n bits +      */  \
    /* high parts n*high_bits bits + low parts n*low_bits bits */              \
    size_t type_bits = sizeof(T) * 8;                                          \
    return RLE_GEF_BLOB_HEADER_BYTES + words_for(n) * 8 +                      \
           words_for(n * type_bits) * 8 + words_for(n * type_bits) * 8;        \
}                                                                              \
                                                                               \
int rle_gef_##Suffix##_pack(const rle_gef_##Suffix *rle, uint8_t *out,         \
                            size_t cap) {                                      \
    if (!rle || !out || cap < rle_gef_##Suffix##_blob_size(rle))               \
        return -1;                                                             \
    put_u32(out, (uint32_t)rle->sample_count);                                 \
    put_u32(out + 4, (uint32_t)rle->run_values.length);                        \
    put_u16(out + 8, (uint16_t)rle->base);                                     \
    out[10] = rle->low_bits;                                                   \
    out[11] = rle->high_bits;                                                  \
    size_t offset = RLE_GEF_BLOB_HEADER_BYTES;                                 \
    if (rle->high_bits > 0) {                                                  \
        size_t word_count = words_for(rle->run_boundaries.bit_count);          \
        for (size_t i = 0; i < word_count; i++)                                \
            put_u64(out + offset + i * 8, rle->run_boundaries.words[i]);       \
        offset += word_count * 8;                                              \
    }                                                                          \
    {                                                                          \
        size_t word_count =                                                    \
            words_for((size_t)rle->run_values.length * rle->high_bits);        \
        for (size_t i = 0; i < word_count; i++)                                \
            put_u64(out + offset + i * 8, rle->run_values.words[i]);           \
        offset += word_count * 8;                                              \
    }                                                                          \
    {                                                                          \
        size_t word_count =                                                    \
            words_for((size_t)rle->low_parts.length * rle->low_bits);          \
        for (size_t i = 0; i < word_count; i++)                                \
            put_u64(out + offset + i * 8, rle->low_parts.words[i]);            \
        offset += word_count * 8;                                              \
    }                                                                          \
    return (int)offset;                                                        \
}                                                                              \
                                                                               \
int rle_gef_##Suffix##_unpack(rle_gef_##Suffix *rle, const uint8_t *in,        \
                              size_t len) {                                    \
    rle_gef_##Suffix##_init(rle);                                              \
    if (!in || len < RLE_GEF_BLOB_HEADER_BYTES)                                \
        return -1;                                                             \
    uint32_t n = get_u32(in);                                                  \
    uint32_t runs = get_u32(in + 4);                                           \
    T base = (T)get_u16(in + 8);                                               \
    uint8_t low_bits = in[10];                                                 \
    uint8_t high_bits = in[11];                                                \
    uint8_t type_bits = (uint8_t)(sizeof(T) * 8);                              \
    if (low_bits > type_bits || high_bits > type_bits ||                       \
        (uint8_t)(low_bits + high_bits) > type_bits)                           \
        return -1;                                                             \
    if (n > 0 && low_bits == 0 && high_bits == 0)                              \
        return -1;                                                             \
    if (high_bits > 0 && n > 0 && runs == 0)                                   \
        return -1;                                                             \
    size_t boundary_words = (high_bits > 0) ? words_for(n) : 0;                \
    size_t high_words = words_for((size_t)runs * high_bits);                   \
    size_t low_words = words_for((size_t)n * low_bits);                        \
    size_t needed = RLE_GEF_BLOB_HEADER_BYTES +                                \
                    (boundary_words + high_words + low_words) * 8;             \
    if (needed != len)                                                         \
        return -1;                                                             \
                                                                               \
    rle->sample_count = n;                                                     \
    rle->base = base;                                                          \
    rle->low_bits = low_bits;                                                  \
    rle->high_bits = high_bits;                                                \
    size_t offset = RLE_GEF_BLOB_HEADER_BYTES;                                 \
    if (boundary_words) {                                                      \
        bit_vector_init(&rle->run_boundaries, n);                              \
        if (!rle->run_boundaries.words) goto fail;                             \
        for (size_t i = 0; i < boundary_words; i++)                            \
            rle->run_boundaries.words[i] = get_u64(in + offset + i * 8);       \
        offset += boundary_words * 8;                                          \
    }                                                                          \
    if (high_words) {                                                          \
        packed_vector_init(&rle->run_values, runs, high_bits);                 \
        if (!rle->run_values.words) goto fail;                                 \
        for (size_t i = 0; i < high_words; i++)                                \
            rle->run_values.words[i] = get_u64(in + offset + i * 8);           \
        offset += high_words * 8;                                              \
    }                                                                          \
    if (low_words) {                                                           \
        packed_vector_init(&rle->low_parts, n, low_bits);                      \
        if (!rle->low_parts.words) goto fail;                                  \
        for (size_t i = 0; i < low_words; i++)                                 \
            rle->low_parts.words[i] = get_u64(in + offset + i * 8);            \
    }                                                                          \
    return 0;                                                                  \
fail:                                                                          \
    rle_gef_##Suffix##_destroy(rle);                                           \
    return -1;                                                                 \
}

#if RGEF_ENABLE_I8
RLE_GEF_IMPL(i8, int8_t, uint8_t)
#endif
#if RGEF_ENABLE_I16
RLE_GEF_IMPL(i16, int16_t, uint16_t)
#endif
