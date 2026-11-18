/*
 * huff_delta.h — lossy-then-Huffman delta codec for 64-bit integer sequences.
 *
 * Pipeline per chunk:  x -> drop N LSBs (device quantizer) -> delta -> Huffman
 *
 *   q[i]  = sign(x[i]) * ((|x[i]| + 2^(N-1)) >> N)      (N = drop_bits)
 *   d[i]  = q[i] - q[i-1]                               (wrapping int64)
 *   u[i]  = d[i] / 2^N                                  (exact, |u| bounded)
 *
 * u values inside [-K, K] are coded with a canonical Huffman table trained on
 * a prefix of the stream (K bounds the table: 2K+2 symbols including the
 * escape); other values use the escape symbol followed by a zig-zag value of
 * `esc_bits` bits (the width is stored per chunk). The first value of every
 * chunk is stored raw (int64), so chunks are independent of each other.
 *
 * The table (K and the 2K+2 code lengths) is serialised once per stream, so a
 * stream is: table block, then chunk blocks. Lossless means drop_bits = 0;
 * with drop_bits > 0 the reconstruction error is <= 2^(N-1) LSB per sample.
 */
#ifndef HUFF_DELTA_H
#define HUFF_DELTA_H

#include <stddef.h>
#include <stdint.h>

#define HD_MAX_K       2047
#define HD_FLAG_UPDATE 0x80                 /* esc_bits byte: table follows  */
#define HD_FLAG_FALLBACK 0x80000000u        /* chunk size field: exact body  */
#define HD_FLAG_VARINT   0x40000000u        /* with fallback: LEB128 deltas  */
#define HD_HDR_TABLE   12                   /* size u32, drop u8, K u16,
                                               nsym u16, esc... reserved    */
#define HD_HDR_CHUNK   17                   /* size u32, count u32, first i64,
                                               esc_bits u8                 */

typedef struct {
    int drop_bits;                          /* LSBs discarded (0 = lossless)*/
    int32_t K;                              /* symbol half-range            */
    uint32_t nsym;                          /* 2K + 2 (incl. escape)        */
    uint8_t len[2 * HD_MAX_K + 2];          /* code lengths                 */
    uint64_t code[2 * HD_MAX_K + 2];        /* canonical codes (encoder)    */
    uint16_t sym_order[2 * HD_MAX_K + 2];   /* symbols sorted by (len, id)  */
    uint32_t hist[2 * HD_MAX_K + 2];        /* training histogram (scratch) */
} hd_table;

/* Training: feed whole chunks, then finish (builds the Huffman table). */
void hd_table_init(hd_table *table, int drop_bits, int32_t K);
void hd_train_chunk(hd_table *table, const int64_t *values, size_t count);
int hd_finish_training(hd_table *table);        /* 0 ok, -1 no symbols */

/* Table serialisation (once per stream). Returns bytes written / needed. */
size_t hd_table_bytes(const hd_table *table);
size_t hd_write_table(const hd_table *table, uint8_t *out, size_t cap);
size_t hd_read_table(hd_table *table, const uint8_t *in, size_t len);

/*
 * Chunk codec. Returns bytes written, 0 on error/overflow.
 * With update != 0 the current table is embedded in the chunk (the flag is
 * set in the esc_bits byte), which is how the adaptive mode switches tables
 * in a stream without any lookahead. hd_encode_chunk() is update = 0.
 */
size_t hd_encode_chunk_flag(const hd_table *table, const int64_t *values, size_t count,
                            uint8_t *out, size_t cap, int update);
size_t hd_encode_chunk(const hd_table *table, const int64_t *values, size_t count,
                       uint8_t *out, size_t cap);

/*
 * Encode a chunk with the smaller of the Huffman payload and an exact
 * fallback (raw or zig-zag LEB128 deltas of the quantized values).  Sets
 * *fallback to 1 when the fallback won.  The fallback is signalled by the
 * high bit of the chunk size field, so old streams and the plain decoder
 * path are unchanged.
 */
size_t hd_encode_chunk_best(const hd_table *table, const int64_t *values, size_t count,
                            uint8_t *out, size_t cap, int update,
                            int *fallback);

/* Decoding: hd_decode_chunk_upd() may replace *t when the chunk carries a
 * table update (the table must be mutable). hd_decode_chunk() is the plain
 * path and is only valid for streams without updates. */
int hd_decode_chunk_upd(hd_table *table, const uint8_t *in, size_t len,
                        int64_t *values, size_t count);
int hd_decode_chunk(const hd_table *table, const uint8_t *in, size_t len,
                    int64_t *values, size_t count);

/*
 * Device quantizer (apps/common.c:chunk_drop_bits). Returns the quotient
 * Q = round(x / 2^drop_bits) with round-to-nearest on the magnitude; the
 * reconstruction is x_hat = Q << drop_bits, so |x - x_hat| <= 2^(drop_bits-1).
 * The coded stream is exactly this quotient sequence (its deltas are the
 * symbols); the magnitude arithmetic is overflow-safe for every int64.
 */
static inline int64_t hd_drop(int64_t x, int drop_bits) {
    if (drop_bits <= 0)
        return x;
    uint64_t half = (uint64_t)1 << (drop_bits - 1);
    uint64_t mag = x < 0 ? (uint64_t)(-(x + 1)) + 1u : (uint64_t)x;
    mag = (mag + half) >> drop_bits;
    return x < 0 ? -(int64_t)mag : (int64_t)mag;
}

/* Worst-case chunk payload bound for count samples. */
size_t hd_max_chunk_payload(size_t count);

#endif /* HUFF_DELTA_H */
