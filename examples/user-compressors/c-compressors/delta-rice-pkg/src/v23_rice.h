/*
 * v23_rice.h — the shipped v23 / v24 delta + Rice format (baseline reference).
 *
 * C11 port of the on-SD IMU format modelled in
 * reference/sa_test/imu_compression.py (v23_encode / v24_encode, the
 * signal_firmware.ino writeBatchRice path). One call codes one "sensor block"
 * of 1..3 axes (the reference sensor block is the 3-axis accelerometer or
 * gyroscope; a PPG triad or a single channel also works).
 *
 * v24 quantizer (drop = b, 0..7; b = 0 is the lossless v23 path):
 *
 *   q = b ? sign(x) * ((|x| + 2^(b-1)) >> b) : x      (lossy_qshift)
 *   reconstruction q << b,  |x - (q << b)| <= 2^(b-1)
 *
 * The n samples of a call are split into consecutive batches of
 * V23_RICE_BATCH (199) samples, the last one shorter. Batch layout (bits
 * MSB-first, exactly the reference _BitWriter):
 *
 *   for each axis a:
 *     u16    anchor q[a][0] (two's complement)
 *     for each block of up to V23_RICE_BLOCK (64) deltas of the batch:
 *       4 bits  k, the exhaustive minimum of sum((u >> k) + 1 + k) over
 *               k = 0..15, first minimum on ties (reference _best_k)
 *       Rice    per delta: u >> k zero bits, a 1, then the k low bits of u
 *               u = zigzag(q[t] - q[t-1]) (exact int32 delta, <= 131070)
 *   zero padding to the next byte boundary (end of the sensor block)
 *
 * Batches restart at every call: a 4096-sample chunk is 20 x 199 + 116.
 * The payload is exactly the reference's sensor-block bytes concatenated over
 * the batches; it stores neither n, the axis count nor the drop, so the
 * caller frames chunks and passes the same values to the decoder (the
 * reference 16-byte LogBatchHeader is not part of the payload).
 *
 * The decoder validates every anchor and reconstructed index against the
 * quantized int16 range, the unary length, the zero padding and the exact
 * payload length; it never writes past n samples per axis.
 *
 * Memory: no heap, no workspace, no static state. The encoder keeps one block
 * of zig-zag codes on the stack (64 x u32); the decoder only locals.
 */
#ifndef V23_RICE_H
#define V23_RICE_H

#include <stddef.h>
#include <stdint.h>

#define V23_RICE_BATCH      199
#define V23_RICE_BLOCK      64
#define V23_RICE_K_BITS     4
#define V23_RICE_MAX_AXES   3
#define V23_RICE_MAX_DROP   7

/* The v24 quantizer: lossy_qshift(x, drop). drop = 0 is the identity. */
int16_t v23_rice_qshift(int16_t x, int drop);

/* Worst-case payload bytes for n samples on each of `axes` axes; 0 for a bad
 * argument. With the optimal k every code costs at most 19 bits. */
size_t v23_rice_max_bytes(size_t n, int axes);

/* Encode n samples of each axis (in[a] points to n int16). Returns payload
 * bytes, or 0 on error (n == 0, axes outside 1..3, drop outside 0..7, cap
 * too small). */
size_t v23_rice_encode(const int16_t *const *in, int axes, size_t n, int drop,
                       uint8_t *out, size_t cap);

/* Decode a payload produced with the same n, axes and drop. out[a] receives n
 * reconstructed samples (q << drop). Returns 0, or -1 on malformed input. */
int v23_rice_decode(const uint8_t *in, size_t len, int axes, size_t n,
                    int drop, int32_t *const *out);

#endif /* V23_RICE_H */
