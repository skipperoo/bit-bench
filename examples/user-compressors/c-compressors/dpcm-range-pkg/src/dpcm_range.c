/*
 * dpcm_range.c — see dpcm_range.h.  Integer-only, no heap, no stdio.
 */
#include "dpcm_range.h"

#include <string.h>

#ifndef DPCM_RANGE_RATE_ZERO
#define DPCM_RANGE_RATE_ZERO 4
#endif
#ifndef DPCM_RANGE_RATE_EXP
#define DPCM_RANGE_RATE_EXP  4
#endif
#ifndef DPCM_RANGE_RATE_SIGN
#define DPCM_RANGE_RATE_SIGN 5
#endif
#ifndef DPCM_RANGE_RATE_MAN
#define DPCM_RANGE_RATE_MAN  5
#endif

/* ---------------- integer helpers ---------------- */

static int bit_length64(uint64_t v) {
    int n = 0;
    while (v) { n++; v >>= 1; }
    return n;
}

static uint64_t absolute64(int64_t v) {
    return v < 0 ? (uint64_t)(-(v + 1)) + 1u : (uint64_t)v;
}

/* Nearest multiple index: round(residual / step), ties away from zero. */
static int64_t nearest_index(int64_t residual, int32_t step) {
    int64_t half = step / 2;
    if (residual >= 0)
        return (residual + half) / step;
    return -((-residual + half) / step);
}

/* ---------------- byte / varint helpers ---------------- */

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put_u16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
}
static uint16_t get_u16(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

/* Zig-zag LEB128.  *offset is always advanced; *ok is cleared on overflow. */
static void put_svar(uint8_t *out, size_t cap, size_t *offset, int64_t v,
                     int *ok) {
    uint64_t u = ((uint64_t)v << 1) ^ (uint64_t)(v >> 63);
    do {
        uint8_t b = (uint8_t)(u & 0x7Fu);
        u >>= 7;
        if (u)
            b |= 0x80u;
        if (*offset < cap)
            out[*offset] = b;
        else
            *ok = 0;
        (*offset)++;
    } while (u);
}

/* Returns 0 on success, -1 on truncation/overflow. */
static int get_svar(const uint8_t *in, size_t len, size_t *offset, int64_t *v) {
    uint64_t u = 0;
    int shift = 0;
    for (int i = 0; i < 10; i++) {
        if (*offset >= len)
            return -1;
        uint8_t b = in[(*offset)++];
        if (shift == 63 && (b & 0xFEu))
            return -1;
        u |= (uint64_t)(b & 0x7Fu) << shift;
        if (!(b & 0x80u)) {
            *v = (int64_t)((u >> 1) ^ (uint64_t)-(int64_t)(u & 1));
            return 0;
        }
        shift += 7;
    }
    return -1;
}

/* ---------------- range encoder (LZMA-style) ---------------- */

typedef struct {
    uint64_t low;
    uint32_t range;
    uint8_t cache;
    uint64_t cache_size;
    uint8_t *out;
    size_t cap, len;
    int ok;
} range_encoder;

static void range_encoder_put(range_encoder *encoder, uint8_t b) {
    if (encoder->len < encoder->cap)
        encoder->out[encoder->len] = b;
    else
        encoder->ok = 0;
    encoder->len++;
}

static void range_encoder_shift_low(range_encoder *encoder) {
    if ((uint32_t)encoder->low < 0xFF000000u || (encoder->low >> 32) != 0) {
        uint8_t carry = (uint8_t)(encoder->low >> 32);
        uint8_t temp = encoder->cache;
        do {
            range_encoder_put(encoder, (uint8_t)(temp + carry));
            temp = 0xFF;
        } while (--encoder->cache_size != 0);
        encoder->cache = (uint8_t)((uint32_t)encoder->low >> 24);
    }
    encoder->cache_size++;
    encoder->low = (uint64_t)((uint32_t)encoder->low << 8);
}

static void range_encoder_init(range_encoder *encoder, uint8_t *out, size_t cap) {
    encoder->low = 0; encoder->range = 0xFFFFFFFFu; encoder->cache = 0; encoder->cache_size = 1;
    encoder->out = out; encoder->cap = cap; encoder->len = 0; encoder->ok = 1;
}

static void range_encoder_bit(range_encoder *encoder, uint32_t p, int bit) {
    uint32_t bound = (encoder->range >> 12) * p;
    if (!bit) {
        encoder->range = bound;
    } else {
        encoder->low += bound;
        encoder->range -= bound;
    }
    while (encoder->range < (1u << 24)) {
        encoder->range <<= 8;
        range_encoder_shift_low(encoder);
    }
}

static void range_encoder_direct(range_encoder *encoder, int bit) {
    encoder->range >>= 1;
    if (bit)
        encoder->low += encoder->range;
    while (encoder->range < (1u << 24)) {
        encoder->range <<= 8;
        range_encoder_shift_low(encoder);
    }
}

static void range_encoder_flush(range_encoder *encoder) {
    for (int i = 0; i < 5; i++)
        range_encoder_shift_low(encoder);
}

/* ---------------- range decoder ---------------- */

typedef struct {
    uint32_t code, range;
    const uint8_t *in;
    size_t len, pos;
    int fail;
} range_decoder;

static uint8_t range_decoder_get(range_decoder *decoder) {
    if (decoder->pos >= decoder->len) { decoder->fail = 1; return 0; }
    return decoder->in[decoder->pos++];
}

static void range_decoder_init(range_decoder *decoder, const uint8_t *in, size_t len) {
    decoder->range = 0xFFFFFFFFu; decoder->code = 0; decoder->in = in; decoder->len = len;
    decoder->pos = 0; decoder->fail = 0;
    for (int i = 0; i < 5; i++)
        decoder->code = (decoder->code << 8) | range_decoder_get(decoder);
}

static int range_decoder_bit(range_decoder *decoder, uint32_t p) {
    uint32_t bound = (decoder->range >> 12) * p;
    int bit;
    if (decoder->code < bound) {
        decoder->range = bound;
        bit = 0;
    } else {
        decoder->code -= bound;
        decoder->range -= bound;
        bit = 1;
    }
    while (decoder->range < (1u << 24)) {
        decoder->range <<= 8;
        decoder->code = (decoder->code << 8) | range_decoder_get(decoder);
    }
    return bit;
}

static int range_decoder_direct(range_decoder *decoder) {
    decoder->range >>= 1;
    int bit = decoder->code >= decoder->range;
    if (bit)
        decoder->code -= decoder->range;
    while (decoder->range < (1u << 24)) {
        decoder->range <<= 8;
        decoder->code = (decoder->code << 8) | range_decoder_get(decoder);
    }
    return bit;
}

/* ---------------- probabilities / contexts ---------------- */

static inline uint32_t probability_get(const dpcm_range_state *state, int ctx, int slot) {
    return (uint32_t)state->probabilities[(size_t)ctx * DPCM_RANGE_CONTEXT_BYTES + slot] << 4;
}

static inline void probability_update(dpcm_range_state *state, int ctx, int slot, int bit, int rate) {
    uint8_t *p = &state->probabilities[(size_t)ctx * DPCM_RANGE_CONTEXT_BYTES + slot];
    if (!bit)
        *p = (uint8_t)(*p + ((256 - *p) >> rate));
    else
        *p = (uint8_t)(*p - (*p >> rate));
    if (*p == 0)
        *p = 1;
}

static void update_context(dpcm_range_state *state, int lane, int64_t k) {
    int e = bit_length64(absolute64(k));
    if (e > 16)
        e = 16;
    state->exponent_before_previous[lane] = state->previous_exponent[lane];
    state->previous_exponent[lane] = e;
    state->previous_sign[lane] = (int8_t)((k > 0) - (k < 0));
}

/* 4-level selector for the 204-context model, computed before the current
 * time step is coded, so every lane sees the other lanes at t-1. */
static void selector_for_lanes(const dpcm_range_state *state, int selectors[DPCM_RANGE_MAX_LANES]) {
    for (int a = 0; a < state->lane_count; a++) {
        int om = 0;
        if (state->lane_count == 6) {
            int base = (a / 3) * 3;
            int o1 = base + ((a - base + 1) % 3);
            int o2 = base + ((a - base + 2) % 3);
            om = state->previous_exponent[o1] > state->previous_exponent[o2] ? state->previous_exponent[o1] : state->previous_exponent[o2];
        }
        int e2 = state->exponent_before_previous[a];
        if (e2 > om) om = e2;
        if (om > 3) om = 3;
        selectors[a] = om;
    }
}

static int context_index(const dpcm_range_state *state, int lane, int selectors) {
    int e1 = state->previous_exponent[lane];
    if (e1 > 16) e1 = 16;
    return (e1 * 3 + (state->previous_sign[lane] + 1)) * 4 + selectors;
}

/* ---------------- symbol codec ---------------- */

static int range_put_symbol(range_encoder *encoder, dpcm_range_state *state, int ctx, int64_t k) {
    uint64_t mag = absolute64(k);
    int z = (mag == 0);
    range_encoder_bit(encoder, probability_get(state, ctx, 0), z ? 0 : 1);
    probability_update(state, ctx, 0, z ? 0 : 1, DPCM_RANGE_RATE_ZERO);
    if (z)
        return 0;

    int neg = k < 0;
    range_encoder_bit(encoder, probability_get(state, ctx, 1), neg);
    probability_update(state, ctx, 1, neg, DPCM_RANGE_RATE_SIGN);

    int ex = bit_length64(mag);              /* >= 1 */
    int ee = ex - 1;
    int i;
    for (i = 0; i < DPCM_RANGE_MAX_EXPONENT; i++) {
        int more = ee > i;
        range_encoder_bit(encoder, probability_get(state, ctx, 2 + i), more);
        probability_update(state, ctx, 2 + i, more, DPCM_RANGE_RATE_EXP);
        if (!more)
            break;
    }
    if (i == DPCM_RANGE_MAX_EXPONENT) {
        int x = ex - DPCM_RANGE_MAX_EXPONENT - 1;
        if (x < 0 || x > 15)
            return -1;
        for (int b = 3; b >= 0; b--)
            range_encoder_direct(encoder, (x >> b) & 1);
    }

    int nbits = ex - 1;
    uint64_t m = mag - (UINT64_C(1) << (ex - 1));
    if (nbits >= 1) {
        int b = (int)((m >> (nbits - 1)) & 1);
        range_encoder_bit(encoder, probability_get(state, ctx, 14), b);
        probability_update(state, ctx, 14, b, DPCM_RANGE_RATE_MAN);
    }
    if (nbits >= 2) {
        int b = (int)((m >> (nbits - 2)) & 1);
        range_encoder_bit(encoder, probability_get(state, ctx, 15), b);
        probability_update(state, ctx, 15, b, DPCM_RANGE_RATE_MAN);
    }
    for (int b = nbits - 3; b >= 0; b--)
        range_encoder_direct(encoder, (int)((m >> b) & 1));
    return 0;
}

static int range_get_symbol(range_decoder *decoder, dpcm_range_state *state, int ctx, int64_t *kout) {
    int z = range_decoder_bit(decoder, probability_get(state, ctx, 0));
    probability_update(state, ctx, 0, z, DPCM_RANGE_RATE_ZERO);
    if (!z) {
        *kout = 0;
        return 0;
    }

    int neg = range_decoder_bit(decoder, probability_get(state, ctx, 1));
    probability_update(state, ctx, 1, neg, DPCM_RANGE_RATE_SIGN);

    int ex = 1;
    int i;
    for (i = 0; i < DPCM_RANGE_MAX_EXPONENT; i++) {
        int more = range_decoder_bit(decoder, probability_get(state, ctx, 2 + i));
        probability_update(state, ctx, 2 + i, more, DPCM_RANGE_RATE_EXP);
        if (!more)
            break;
        ex++;
    }
    if (i == DPCM_RANGE_MAX_EXPONENT) {
        int x = 0;
        for (int b = 0; b < 4; b++)
            x = (x << 1) | range_decoder_direct(decoder);
        ex = DPCM_RANGE_MAX_EXPONENT + 1 + x;
    }
    if (ex < 1 || ex > 63)
        return -1;

    int nbits = ex - 1;
    uint64_t m = 0;
    if (nbits >= 1) {
        int b = range_decoder_bit(decoder, probability_get(state, ctx, 14));
        probability_update(state, ctx, 14, b, DPCM_RANGE_RATE_MAN);
        m |= (uint64_t)b << (nbits - 1);
    }
    if (nbits >= 2) {
        int b = range_decoder_bit(decoder, probability_get(state, ctx, 15));
        probability_update(state, ctx, 15, b, DPCM_RANGE_RATE_MAN);
        m |= (uint64_t)b << (nbits - 2);
    }
    for (int b = nbits - 3; b >= 0; b--)
        m |= (uint64_t)range_decoder_direct(decoder) << b;

    uint64_t mag = (UINT64_C(1) << (ex - 1)) | m;
    *kout = neg ? -(int64_t)mag : (int64_t)mag;
    return 0;
}

/* ---------------- public API ---------------- */

void dpcm_range_init(dpcm_range_state *state, int epsilon, int lanes,
                     uint8_t *probability_buffer) {
    if (!state)
        return;
    memset(state, 0, sizeof *state);
    if (epsilon < 0)
        epsilon = 0;
    if (epsilon > (INT32_MAX - 1) / 2)
        epsilon = (INT32_MAX - 1) / 2;
    state->epsilon = epsilon;
    state->quantiser_step = 2 * epsilon + 1;
    state->lane_count = lanes < 1 ? 1
                  : (lanes > DPCM_RANGE_MAX_LANES ? DPCM_RANGE_MAX_LANES : lanes);
    state->probabilities = probability_buffer;
    if (probability_buffer)
        memset(probability_buffer, 128,
               (size_t)DPCM_RANGE_CONTEXTS * DPCM_RANGE_CONTEXT_BYTES);
}

size_t dpcm_range_max_chunk_bytes(size_t n, int lanes) {
    if (lanes < 1) lanes = 1;
    if (lanes > DPCM_RANGE_MAX_LANES) lanes = DPCM_RANGE_MAX_LANES;
    return DPCM_RANGE_CHUNK_HEADER_BYTES + (size_t)lanes * 5 + n * (size_t)lanes * 8 + 64;
}

size_t dpcm_range_encode_chunk(dpcm_range_state *state, const int16_t *const *in, size_t n,
                        uint8_t *out, size_t cap, dpcm_range_stats *stats) {
    if (!state || !state->probabilities || !in || !out || n == 0 ||
        cap < DPCM_RANGE_CHUNK_HEADER_BYTES)
        return 0;

    put_u32(out, 0);
    put_u32(out + 4, (uint32_t)n);
    put_u16(out + 8, (uint16_t)state->lane_count);
    put_u16(out + 10, DPCM_RANGE_CONTEXTS);
    size_t offset = DPCM_RANGE_CHUNK_HEADER_BYTES;
    int ok = 1;

    int64_t reconstruction[DPCM_RANGE_MAX_LANES];
    dpcm_range_stats local = {0, 0, 0};
    /* epsilon = 0 (q = 1) is the lossless mode: the quantiser is the
     * identity, so it is skipped (no division) and the residual is the plain
     * delta. The bytes are those of the generic path with q = 1. */
    const int lossless = state->quantiser_step == 1;

    for (int a = 0; a < state->lane_count; a++) {
        int64_t anchor_index = lossless ? (int64_t)in[a][0]
                             : nearest_index(in[a][0], state->quantiser_step);
        reconstruction[a] = anchor_index * state->quantiser_step;
        put_svar(out, cap, &offset, anchor_index, &ok);
        int64_t err = (int64_t)in[a][0] - reconstruction[a];
        uint64_t absolute_error = (uint64_t)(err < 0 ? -err : err);
        if (absolute_error > (uint64_t)state->epsilon)
            return 0;
        if (absolute_error > local.max_error) local.max_error = absolute_error;
        local.sum_error += absolute_error;
        local.samples++;
        update_context(state, a, anchor_index);
    }
    if (!ok || offset > cap)
        return 0;

    range_encoder encoder;
    range_encoder_init(&encoder, out + offset, cap - offset);

    for (size_t t = 1; t < n; t++) {
        int selectors[DPCM_RANGE_MAX_LANES];
        selector_for_lanes(state, selectors);
        for (int a = 0; a < state->lane_count; a++) {
            int64_t residual = (int64_t)in[a][t] - reconstruction[a];
            int64_t k;
            if (lossless) {
                k = residual;
                reconstruction[a] = in[a][t];
            } else {
                k = nearest_index(residual, state->quantiser_step);
                reconstruction[a] += k * state->quantiser_step;
                int64_t err = (int64_t)in[a][t] - reconstruction[a];
                uint64_t absolute_error = (uint64_t)(err < 0 ? -err : err);
                if (absolute_error > (uint64_t)state->epsilon)
                    return 0;
                if (absolute_error > local.max_error) local.max_error = absolute_error;
                local.sum_error += absolute_error;
            }
            local.samples++;
            int context = context_index(state, a, selectors[a]);
            if (range_put_symbol(&encoder, state, context, k) != 0 ||
                !encoder.ok)
                return 0;
            update_context(state, a, k);
        }
    }

    range_encoder_flush(&encoder);
    if (!encoder.ok || offset + encoder.len > cap)
        return 0;
    put_u32(out, (uint32_t)(offset + encoder.len));
    if (stats) {
        stats->max_error = local.max_error > stats->max_error
                         ? local.max_error : stats->max_error;
        stats->sum_error += local.sum_error;
        stats->samples += local.samples;
    }
    return offset + encoder.len;
}

int dpcm_range_decode_chunk(dpcm_range_state *state, const uint8_t *in, size_t len,
                     int32_t *const *out, size_t n) {
    if (!state || !state->probabilities || !in || !out || n == 0 ||
        len < DPCM_RANGE_CHUNK_HEADER_BYTES)
        return -1;
    uint32_t total = get_u32(in);
    uint32_t cn = get_u32(in + 4);
    int lanes = get_u16(in + 8);
    int context_count = get_u16(in + 10);
    if (total > len || total < DPCM_RANGE_CHUNK_HEADER_BYTES || cn != n ||
        lanes != state->lane_count || context_count != DPCM_RANGE_CONTEXTS)
        return -1;

    size_t offset = DPCM_RANGE_CHUNK_HEADER_BYTES;
    int64_t reconstruction[DPCM_RANGE_MAX_LANES];
    const int lossless = state->quantiser_step == 1;   /* epsilon = 0 */
    for (int a = 0; a < state->lane_count; a++) {
        int64_t anchor_index;
        if (get_svar(in, total, &offset, &anchor_index) != 0)
            return -1;
        reconstruction[a] = anchor_index * state->quantiser_step;
        if (reconstruction[a] < INT32_MIN || reconstruction[a] > INT32_MAX)
            return -1;
        out[a][0] = (int32_t)reconstruction[a];
        update_context(state, a, anchor_index);
    }

    range_decoder decoder;
    range_decoder_init(&decoder, in + offset, total - offset);

    for (size_t t = 1; t < n; t++) {
        int selectors[DPCM_RANGE_MAX_LANES];
        selector_for_lanes(state, selectors);
        for (int a = 0; a < state->lane_count; a++) {
            int64_t k;
            int context = context_index(state, a, selectors[a]);
            if (range_get_symbol(&decoder, state, context, &k) != 0)
                return -1;
            int64_t v = reconstruction[a] +
                        (lossless ? k : k * (int64_t)state->quantiser_step);
            if (v < INT32_MIN || v > INT32_MAX)
                return -1;
            reconstruction[a] = v;
            out[a][t] = (int32_t)v;
            update_context(state, a, k);
        }
    }
    if (decoder.fail)
        return -1;
    return 0;
}

size_t dpcm_range_pack(const int16_t *x, size_t n, int eps,
                       uint8_t *out, size_t cap, dpcm_range_stats *stats) {
    if (!x || !out || cap < DPCM_RANGE_STREAM_HEADER_BYTES)
        return 0;
    uint8_t probs[DPCM_RANGE_CONTEXTS * DPCM_RANGE_CONTEXT_BYTES];
    dpcm_range_state state;
    dpcm_range_init(&state, eps, 1, probs);
    memcpy(out, "DPR1", 4);
    out[4] = 1;
    out[5] = DPCM_RANGE_CONTEXTS;
    put_u16(out + 6, 1);
    put_u32(out + 8, (uint32_t)eps);
    put_u32(out + 12, (uint32_t)n);
    size_t offset = DPCM_RANGE_STREAM_HEADER_BYTES;
    for (size_t off = 0; off < n; off += 4096) {
        size_t cn = n - off < 4096 ? n - off : 4096;
        const int16_t *lanes[1] = { x + off };
        if (cap - offset < 4)
            return 0;
        size_t z = dpcm_range_encode_chunk(&state, lanes, cn, out + offset + 4, cap - offset - 4,
                                    stats);
        if (!z)
            return 0;
        put_u32(out + offset, (uint32_t)z);
        offset += 4 + z;
    }
    return offset;
}

int dpcm_range_unpack(const uint8_t *in, size_t len, int32_t *x) {
    if (!in || !x || len < DPCM_RANGE_STREAM_HEADER_BYTES || memcmp(in, "DPR1", 4) != 0)
        return -1;
    if (in[4] != 1)
        return -1;
    int context_count = in[5];
    int lanes = get_u16(in + 6);
    int eps = (int)get_u32(in + 8);
    uint32_t n = get_u32(in + 12);
    if (context_count != DPCM_RANGE_CONTEXTS)
        return -1;
    if (lanes != 1 || eps < 0 || eps > (1 << 20))
        return -1;
    uint8_t probs[DPCM_RANGE_CONTEXTS * DPCM_RANGE_CONTEXT_BYTES];
    dpcm_range_state state;
    dpcm_range_init(&state, eps, 1, probs);
    size_t offset = DPCM_RANGE_STREAM_HEADER_BYTES;
    for (uint32_t off = 0; off < n; off += 4096) {
        uint32_t cn = n - off < 4096 ? n - off : 4096;
        if (offset + 4 > len)
            return -1;
        uint32_t z = get_u32(in + offset);
        offset += 4;
        if (z == 0 || offset + z > len)
            return -1;
        int32_t *lanes_out[1] = { x + off };
        if (dpcm_range_decode_chunk(&state, in + offset, z, lanes_out, cn) != 0)
            return -1;
        offset += z;
    }
    return offset == len ? 0 : -1;
}
