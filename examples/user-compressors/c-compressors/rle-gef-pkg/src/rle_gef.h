/*
 * rle_gef.h — configurable RLE-GEF codec for microcontrollers.
 *
 * Layout (same scheme as the C++ RLE_GEF / the original C port):
 *   - values are shifted by the sequence minimum (base), so the stored
 *     sequence falls in [0, 2^total_bits);
 *   - each shifted value splits into low_bits low bits (L) and
 *     high_bits = total_bits - low_bits high bits; run_boundaries has one
 *     bit per sample marking where the high part changes and run_values
 *     stores the distinct high parts (one per run);
 *   - low_bits is chosen to minimise the true coded size white-box: an O(n)
 *     LCP histogram followed by an O(total_bits) scan (no temporary array).
 *
 * Memory: the codec allocates only the run_boundaries/run_values/low_parts
 * arrays through RGEF_MALLOC at build/unpack time and frees them in destroy.
 * Peak = n/8 + n*low_bits/8 + runs*high_bits/8 bytes plus metadata. There is
 * no rank index and no random access.
 *
 * Packed blob (little-endian), used to store or transmit a compressed chunk:
 *   u32 sample_count | u32 runs | i16 base | u8 low_bits | u8 high_bits
 *   run_boundaries words (ceil(n/64) x u64) |
 *   run_values words (ceil(runs*high_bits/64) x u64) |
 *   low_parts words (ceil(n*low_bits/64) x u64)
 *
 * See rle_gef_config.h for the allocator hooks and the enabled sample types.
 */
#ifndef RLE_GEF_H
#define RLE_GEF_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "rle_gef_config.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Packed blob header: sample_count(4) runs(4) base(2) low_bits(1)
 * high_bits(1). */
#define RLE_GEF_BLOB_HEADER_BYTES 12

/* ---------------- packed unsigned integer array ---------------- */

typedef struct {
    uint64_t *words;
    size_t word_capacity;
    size_t length;
    uint8_t bit_width;      /* bits per element                         */
} rle_gef_packed_vector;

/* ---------------- bit vector (no rank support) ---------------- */

typedef struct {
    uint64_t *words;
    size_t bit_count;
} rle_gef_bit_vector;

/* ---------------- RLE-GEF, one instantiation per sample type ---------------- */

#define RLE_GEF_DECLARE(Suffix, T)                                             \
                                                                               \
typedef struct {                                                               \
    rle_gef_bit_vector run_boundaries;                                         \
    rle_gef_packed_vector run_values;   /* distinct high parts              */ \
    rle_gef_packed_vector low_parts;    /* low bits per sample              */ \
    uint8_t    low_bits;                                                       \
    uint8_t    high_bits;                                                      \
    size_t     sample_count;                                                   \
    T          base;       /* sequence minimum, added back on decode      */ \
} rle_gef_##Suffix;                                                            \
                                                                               \
void   rle_gef_##Suffix##_init(rle_gef_##Suffix *rle);                         \
void   rle_gef_##Suffix##_destroy(rle_gef_##Suffix *rle);                      \
int    rle_gef_##Suffix##_build(rle_gef_##Suffix *rle, const T *samples,       \
                                size_t n);                                     \
T      rle_gef_##Suffix##_get(const rle_gef_##Suffix *rle, size_t index);      \
size_t rle_gef_##Suffix##_get_elements(const rle_gef_##Suffix *rle,            \
                                       size_t start, size_t count, T *out);    \
size_t rle_gef_##Suffix##_size(const rle_gef_##Suffix *rle);                   \
size_t rle_gef_##Suffix##_size_in_bytes(const rle_gef_##Suffix *rle);          \
size_t rle_gef_##Suffix##_packed_bits(const rle_gef_##Suffix *rle);            \
size_t rle_gef_##Suffix##_runs(const rle_gef_##Suffix *rle);                   \
uint8_t rle_gef_##Suffix##_split_point(const rle_gef_##Suffix *rle);           \
uint8_t rle_gef_##Suffix##_high_bits(const rle_gef_##Suffix *rle);             \
size_t rle_gef_##Suffix##_blob_size(const rle_gef_##Suffix *rle);              \
size_t rle_gef_##Suffix##_blob_size_max(size_t n);                             \
int    rle_gef_##Suffix##_pack(const rle_gef_##Suffix *rle, uint8_t *out,      \
                               size_t cap);                                    \
int    rle_gef_##Suffix##_unpack(rle_gef_##Suffix *rle, const uint8_t *in,     \
                                 size_t len);

#if RGEF_ENABLE_I8
RLE_GEF_DECLARE(i8, int8_t)
#endif
#if RGEF_ENABLE_I16
RLE_GEF_DECLARE(i16, int16_t)
#endif

#ifdef __cplusplus
}
#endif

#endif /* RLE_GEF_H */
