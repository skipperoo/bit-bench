/*
 * huff_delta.c — see huff_delta.h. Streaming, no heap, no stdio.
 */
#include "huff_delta.h"
#include "compact_fallback.h"

#include <string.h>

/* ---------------- serialisation helpers ---------------- */

static void put_u16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static uint16_t get_u16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put_u64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}
static uint64_t get_u64(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v |= (uint64_t)p[i] << (8 * i);
    return v;
}

/* ---------------- bit writer / reader ---------------- */

typedef struct {
    uint8_t *out;
    size_t cap, len;
    uint64_t acc;
    int nbits;
    int overflow;
} bit_writer;

static void bw_init(bit_writer *writer, uint8_t *out, size_t cap) {
    writer->out = out; writer->cap = cap; writer->len = 0; writer->acc = 0; writer->nbits = 0;
    writer->overflow = 0;
}

static void bw_put(bit_writer *writer, uint64_t v, int width) {
    if (width <= 0)
        return;
    while (width > 32) {
        width -= 32;
        bw_put(writer, (v >> width) & 0xFFFFFFFFu, 32);
    }
    if (width <= 0)
        return;
    writer->acc = (writer->acc << width) | (v & (uint64_t)((width >= 32)
                          ? 0xFFFFFFFFu : ((1u << width) - 1u)));
    writer->nbits += width;
    while (writer->nbits >= 8) {
        writer->nbits -= 8;
        if (writer->len < writer->cap)
            writer->out[writer->len] = (uint8_t)(writer->acc >> writer->nbits);
        else
            writer->overflow = 1;
        writer->len++;
    }
}

static void bw_align(bit_writer *writer) {
    if (writer->nbits) bw_put(writer, 0, 8 - writer->nbits);
}
static size_t bw_bytes(const bit_writer *writer) { return writer->len + (writer->nbits ? 1 : 0); }

typedef struct {
    const uint8_t *in;
    size_t len, pos;
    int nbits;
    int fail;
} bit_reader;

static void br_init(bit_reader *reader, const uint8_t *in, size_t len, size_t pos) {
    reader->in = in; reader->len = len; reader->pos = pos; reader->nbits = 0; reader->fail = 0;
}
static int br_bit(bit_reader *reader) {
    if (reader->pos >= reader->len) { reader->fail = 1; return 0; }
    int b = (reader->in[reader->pos] >> (7 - reader->nbits)) & 1;
    if (++reader->nbits == 8) { reader->nbits = 0; reader->pos++; }
    return b;
}
static uint64_t br_get(bit_reader *reader, int width) {
    uint64_t v = 0;
    for (int i = 0; i < width; i++)
        v = (v << 1) | (uint64_t)br_bit(reader);
    return v;
}
static void br_align(bit_reader *reader) {
    if (reader->nbits) { reader->nbits = 0; reader->pos++; }
}

static uint64_t zz64(int64_t d) { return ((uint64_t)d << 1) ^ (uint64_t)(d >> 63); }
static int64_t unzz64(uint64_t u) {
    return (int64_t)((u >> 1) ^ (uint64_t)-(int64_t)(u & 1));
}

/* ---------------- symbol mapping ---------------- */

static inline uint32_t sym_of(const hd_table *table, int64_t delta, int *escape) {
    if (delta >= -(int64_t)table->K && delta <= (int64_t)table->K) {
        *escape = 0;
        return (uint32_t)(delta + table->K);
    }
    *escape = 1;
    return table->nsym - 1;                 /* escape symbol is the last one */
}

static inline int64_t u_of(const hd_table *table, uint32_t sym) {
    return (int64_t)sym - table->K;
}

/* ---------------- training ---------------- */

void hd_table_init(hd_table *table, int drop_bits, int32_t K) {
    memset(table, 0, sizeof *table);
    table->drop_bits = drop_bits;
    if (K < 1) K = 1;
    if (K > HD_MAX_K) K = HD_MAX_K;
    table->K = K;
    table->nsym = (uint32_t)(2 * K + 2);
}

void hd_train_chunk(hd_table *table, const int64_t *values, size_t count) {
    if (count < 2)
        return;
    int64_t prev = hd_drop(values[0], table->drop_bits);
    for (size_t i = 1; i < count; i++) {
        int64_t cur = hd_drop(values[i], table->drop_bits);
        int64_t d = (int64_t)((uint64_t)cur - (uint64_t)prev);   /* wrap */
        int esc;
        uint32_t sym = sym_of(table, d, &esc);
        table->hist[sym]++;
        prev = cur;
    }
}

/*
 * Huffman code lengths: sorted leaves + merged nodes (two-queue method, the
 * classic O(m log m)-with-sort construction). Leaves are encoded as negative
 * node references (-1 - symbol), merged nodes are indices into the arrays.
 */
int hd_finish_training(hd_table *table) {
    enum { MAXN = 2 * HD_MAX_K + 2, MAXNODES = 2 * MAXN };
    static int32_t leaf_sym[MAXN];
    static int32_t mleft[MAXNODES], mright[MAXNODES];
    static uint64_t mcost[MAXNODES];
    static int32_t stack_ref[MAXNODES];
    static uint16_t stack_depth[MAXNODES];

    table->hist[table->nsym - 1] += 1;             /* escape always codeable */
    for (uint32_t s = 0; s < table->nsym; s++)
        table->len[s] = 0;

    int num_leaves = 0;
    for (uint32_t s = 0; s < table->nsym; s++)
        if (table->hist[s])
            leaf_sym[num_leaves++] = (int32_t)s;
    if (num_leaves == 0)
        return -1;
    /* sort leaves by count (insertion sort; the histogram is small) */
    for (int i = 1; i < num_leaves; i++) {
        int32_t v = leaf_sym[i];
        uint64_t c = table->hist[v];
        int j = i - 1;
        while (j >= 0 && table->hist[leaf_sym[j]] > c) {
            leaf_sym[j + 1] = leaf_sym[j];
            j--;
        }
        leaf_sym[j + 1] = v;
    }

    int leaf_pos = 0, num_merged = 0, merged_pos = 0;
    while ((num_leaves - leaf_pos) + (num_merged - merged_pos) > 1) {
        int32_t child[2];
        for (int pick = 0; pick < 2; pick++) {
            uint64_t leaf_cost = leaf_pos < num_leaves
                ? table->hist[leaf_sym[leaf_pos]] : UINT64_MAX;
            uint64_t merged_cost = merged_pos < num_merged
                ? mcost[merged_pos] : UINT64_MAX;
            if (leaf_cost <= merged_cost) {
                child[pick] = -leaf_sym[leaf_pos] - 1;
                leaf_pos++;
            } else {
                child[pick] = merged_pos++;
            }
        }
        mleft[num_merged] = child[0];
        mright[num_merged] = child[1];
        uint64_t cost0 = child[0] < 0
            ? table->hist[-child[0] - 1] : mcost[child[0]];
        uint64_t cost1 = child[1] < 0
            ? table->hist[-child[1] - 1] : mcost[child[1]];
        mcost[num_merged] = cost0 + cost1;
        num_merged++;
    }
    {
        int32_t root = (leaf_pos < num_leaves)
            ? (-leaf_sym[leaf_pos] - 1) : merged_pos;
        int sp = 0;
        stack_ref[sp] = root;
        stack_depth[sp++] = 0;
        while (sp) {
            int32_t ref = stack_ref[--sp];
            int depth = stack_depth[sp];
            if (ref < 0) {
                table->len[-ref - 1] = (uint8_t)(depth ? depth : 1);
                continue;
            }
            if (depth + 1 < 255) {
                stack_ref[sp] = mleft[ref];
                stack_depth[sp++] = (uint16_t)(depth + 1);
                stack_ref[sp] = mright[ref];
                stack_depth[sp++] = (uint16_t)(depth + 1);
            }
        }
    }

    /* canonical codes and the (length, symbol) order used by both sides */
    {
        uint32_t length_count[65] = {0};
        for (uint32_t s = 0; s < table->nsym; s++) {
            if (table->len[s] > 64)
                table->len[s] = 64;
            length_count[table->len[s]]++;
        }
        length_count[0] = 0;
        uint64_t code = 0;
        uint32_t symbol_index = 0;
        for (int l = 1; l <= 64; l++) {
            code <<= 1;                    /* first code of this length */
            for (uint32_t s = 0; s < table->nsym; s++) {
                if (table->len[s] == l) {
                    table->sym_order[symbol_index++] = (uint16_t)s;
                    table->code[s] = code++;
                }
            }
        }
    }
    return 0;
}

/* ---------------- table serialisation ---------------- */

size_t hd_table_bytes(const hd_table *table) {
    return HD_HDR_TABLE + 2u * table->K + 2u;      /* lengths are one byte each */
}

size_t hd_write_table(const hd_table *table, uint8_t *out, size_t cap) {
    size_t need = hd_table_bytes(table);
    if (cap < need)
        return 0;
    put_u32(out, (uint32_t)need);
    out[4] = (uint8_t)table->drop_bits;
    put_u16(out + 5, (uint16_t)table->K);
    put_u16(out + 7, (uint16_t)table->nsym);
    put_u16(out + 9, 0);
    for (uint32_t s = 0; s < table->nsym; s++)
        out[HD_HDR_TABLE + s] = table->len[s];
    return need;
}

size_t hd_read_table(hd_table *table, const uint8_t *in, size_t len) {
    if (len < HD_HDR_TABLE)
        return 0;
    uint32_t size = get_u32(in);
    uint16_t K = get_u16(in + 5);
    uint16_t nsym = get_u16(in + 7);
    if (K < 1 || K > HD_MAX_K || nsym != (uint16_t)(2 * K + 2) ||
        size < HD_HDR_TABLE || size > len ||
        size != HD_HDR_TABLE + (size_t)nsym)
        return 0;
    hd_table_init(table, in[4], K);
    for (uint32_t s = 0; s < nsym; s++) {
        uint8_t l = in[HD_HDR_TABLE + s];
        if (l > 64)
            return 0;
        table->len[s] = l;
    }
    /* rebuild canonical codes and the sorted symbol order */
    uint32_t length_count[65] = {0};
    for (uint32_t s = 0; s < table->nsym; s++)
        length_count[table->len[s]]++;
    length_count[0] = 0;
    uint64_t code = 0;
    uint32_t symbol_index = 0;
    for (int l = 1; l <= 64; l++) {
        code <<= 1;                        /* first code of this length */
        for (uint32_t s = 0; s < table->nsym; s++) {
            if (table->len[s] == l) {
                table->sym_order[symbol_index++] = (uint16_t)s;
                table->code[s] = code++;
            }
        }
    }
    return size;
}

/* ---------------- chunk encode / decode ---------------- */

static int esc_bits_for(const hd_table *table, const int64_t *values, size_t count) {
    int bits = 1;
    if (count < 2)
        return bits;
    int64_t prev = hd_drop(values[0], table->drop_bits);
    for (size_t i = 1; i < count; i++) {
        int64_t cur = hd_drop(values[i], table->drop_bits);
        int64_t d = (int64_t)((uint64_t)cur - (uint64_t)prev);
        prev = cur;
        int e;
        uint32_t sym = sym_of(table, d, &e);
        if (!e && table->len[sym] != 0)
            continue;                      /* coded without an escape */
        uint64_t z = zz64(d);
        int b = 1;
        while (z >>= 1)
            b++;
        if (b > bits)
            bits = b;
    }
    return bits > 64 ? 64 : bits;
}

size_t hd_encode_chunk_flag(const hd_table *table, const int64_t *values, size_t count,
                            uint8_t *out, size_t cap, int update) {
    if (!table || !values || !out || count == 0 || cap < HD_HDR_CHUNK)
        return 0;
    int esc_bits = esc_bits_for(table, values, count);
    put_u32(out, 0);                       /* size patched below */
    put_u32(out + 4, (uint32_t)count);
    put_u64(out + 8, (uint64_t)hd_drop(values[0], table->drop_bits));  /* quantized */
    out[16] = (uint8_t)(esc_bits | (update ? HD_FLAG_UPDATE : 0));

    size_t payload_pos = HD_HDR_CHUNK;
    if (update) {
        size_t tb = hd_write_table(table, out + payload_pos, cap - payload_pos);
        if (!tb)
            return 0;
        payload_pos += tb;
    }
    bit_writer writer;
    bw_init(&writer, out + payload_pos, cap - payload_pos);
    int64_t prev = hd_drop(values[0], table->drop_bits);
    for (size_t i = 1; i < count; i++) {
        int64_t cur = hd_drop(values[i], table->drop_bits);
        int64_t d = (int64_t)((uint64_t)cur - (uint64_t)prev);
        prev = cur;
        int esc;
        uint32_t sym = sym_of(table, d, &esc);
        if (esc || table->len[sym] == 0) {     /* outside the table or unseen */
            uint32_t esym = table->nsym - 1;
            if (table->len[esym] == 0)
                return 0;                  /* no escape code available */
            bw_put(&writer, table->code[esym], table->len[esym]);
            bw_put(&writer, zz64(d), esc_bits);
        } else {
            bw_put(&writer, table->code[sym], table->len[sym]);
        }
    }
    bw_align(&writer);
    if (writer.overflow)
        return 0;
    size_t total = payload_pos + bw_bytes(&writer);
    if (total > cap)
        return 0;
    put_u32(out, (uint32_t)total);
    return total;
}

size_t hd_encode_chunk(const hd_table *table, const int64_t *values, size_t count,
                       uint8_t *out, size_t cap) {
    return hd_encode_chunk_flag(table, values, count, out, cap, 0);
}

/* Size of the exact fallback body for the original values[1..count). */
static size_t fb_body_size(const int64_t *values, size_t count,
                           int *use_varint) {
    size_t raw_bytes = count > 1 ? (count - 1) * 8 : 0;
    size_t varint_bytes = 0;
    int64_t prev = values[0];
    for (size_t i = 1; i < count; i++) {
        int64_t cur = values[i];
        varint_bytes += cf_uleb_len(cf_zz_diff((uint64_t)cur, (uint64_t)prev));
        prev = cur;
    }
    int use_var = varint_bytes < raw_bytes;
    if (use_varint) *use_varint = use_var;
    return use_var ? varint_bytes : raw_bytes;
}

size_t hd_encode_chunk_best(const hd_table *table, const int64_t *values, size_t count,
                            uint8_t *out, size_t cap, int update,
                            int *fallback) {
    if (fallback) *fallback = 0;
    size_t hlen = hd_encode_chunk_flag(table, values, count, out, cap, update);
    if (!hlen)
        return 0;
    int varint = 0;
    size_t fallback_body = fb_body_size(values, count, &varint);
    size_t fallback_len = HD_HDR_CHUNK +
                          (update ? hd_table_bytes(table) : 0) + fallback_body;
    if (fallback_len >= hlen)
        return hlen;                       /* Huffman path is no larger */
    if (fallback_len > cap || fallback_len >= HD_FLAG_VARINT)
        return hlen;

    put_u32(out, (uint32_t)fallback_len | HD_FLAG_FALLBACK |
                 (varint ? HD_FLAG_VARINT : 0));
    put_u32(out + 4, (uint32_t)count);
    put_u64(out + 8, (uint64_t)values[0]);
    out[16] = (uint8_t)(update ? HD_FLAG_UPDATE : 0);

    size_t payload_pos = HD_HDR_CHUNK;
    if (update) {
        size_t tb = hd_write_table(table, out + payload_pos, cap - payload_pos);
        if (tb != hd_table_bytes(table))
            return 0;
        payload_pos += tb;
    }
    if (varint) {
        int64_t prev = values[0];
        for (size_t i = 1; i < count; i++) {
            int64_t cur = values[i];
            payload_pos += cf_put_uleb(out + payload_pos,
                                       cf_zz_diff((uint64_t)cur, (uint64_t)prev));
            prev = cur;
        }
    } else {
        for (size_t i = 1; i < count; i++) {
            int64_t sample = values[i];
            memcpy(out + payload_pos, &sample, 8);
            payload_pos += 8;
        }
    }
    if (payload_pos != fallback_len)
        return 0;
    if (fallback) *fallback = 1;
    return fallback_len;
}

int hd_decode_chunk_upd(hd_table *table, const uint8_t *in, size_t len,
                        int64_t *values, size_t count) {
    if (!table || !in || !values || len < HD_HDR_CHUNK)
        return -1;
    uint32_t rawsize = get_u32(in);
    uint32_t cn = get_u32(in + 4);
    int is_fb = (rawsize & HD_FLAG_FALLBACK) != 0;
    int is_var = (rawsize & HD_FLAG_VARINT) != 0;
    uint32_t size = rawsize & ~(HD_FLAG_FALLBACK | HD_FLAG_VARINT);
    if (size > len || size < HD_HDR_CHUNK || cn != count || count == 0)
        return -1;
    size_t payload_pos = HD_HDR_CHUNK;
    if (in[16] & HD_FLAG_UPDATE) {         /* the chunk carries its table */
        size_t tb = hd_read_table(table, in + payload_pos, size - payload_pos);
        if (!tb)
            return -1;
        payload_pos += tb;
    }
    values[0] = (int64_t)get_u64(in + 8);
    if (is_fb) {
        if (size < payload_pos)
            return -1;
        if (is_var) {
            if (cf_varint_body_decode(in + payload_pos, size - payload_pos,
                                      values, count) != 0)
                return -1;
        } else {
            if (size - payload_pos != (count - 1) * 8)
                return -1;
            for (size_t i = 1; i < count; i++)
                values[i] = (int64_t)get_u64(in + payload_pos + (i - 1) * 8);
        }
        return 0;
    }
    int esc_bits = in[16] & 0x7F;
    if (esc_bits < 1 || esc_bits > 64)
        return -1;

    /* canonical decoding: first code / first symbol per length */
    uint64_t first_code[65] = {0};
    uint32_t first_sym[65] = {0};
    uint32_t length_count[65] = {0};
    for (uint32_t s = 0; s < table->nsym; s++)
        length_count[table->len[s]]++;
    length_count[0] = 0;
    {
        uint64_t code = 0;
        uint32_t symbol_index = 0;
        for (int l = 1; l <= 64; l++) {
            code = (code + length_count[l - 1]) << 1;
            first_code[l] = code;
            first_sym[l] = symbol_index;
            symbol_index += length_count[l];
        }
        /* same (length, symbol) ordering as the encoder */
        hd_table *mutable_table = (hd_table *)table;
        uint32_t symbol_index2 = 0;
        for (int l = 1; l <= 64; l++)
            for (uint32_t s = 0; s < table->nsym; s++)
                if (table->len[s] == l)
                    mutable_table->sym_order[symbol_index2++] = (uint16_t)s;
    }

    bit_reader reader;
    br_init(&reader, in, size, payload_pos);
    int64_t prev = values[0];                   /* stored quantized */
    for (size_t i = 1; i < count; i++) {
        uint64_t code = 0;
        int len = 0;
        uint32_t sym = table->nsym;            /* invalid */
        for (int l = 1; l <= 64; l++) {
            code = (code << 1) | (uint64_t)br_bit(&reader);
            if (reader.fail)
                return -1;
            if (length_count[l] && code - first_code[l] < length_count[l]) {
                sym = table->sym_order[first_sym[l] +
                                   (uint32_t)(code - first_code[l])];
                len = l;
                break;
            }
        }
        if (sym == table->nsym)
            return -1;
        int64_t d;
        if (sym == table->nsym - 1) {          /* escape */
            d = unzz64(br_get(&reader, esc_bits));
            if (reader.fail)
                return -1;
        } else {
            d = u_of(table, sym);
        }
        int64_t cur = (int64_t)((uint64_t)prev + (uint64_t)d);
        values[i] = cur;
        prev = cur;
        (void)len;
    }
    br_align(&reader);
    if (reader.fail)
        return -1;
    return 0;
}

int hd_decode_chunk(const hd_table *table, const uint8_t *in, size_t len,
                    int64_t *values, size_t count) {
    return hd_decode_chunk_upd((hd_table *)table, in, len, values, count);
}

size_t hd_max_chunk_payload(size_t count) {
    /* every sample escaped: 64-bit zig-zag value + the escape code */
    return HD_HDR_CHUNK + 9 * count + 64;
}
