/* LSB drop as the firmware benchmark (mcu_bindings.c fw_drop): q = sign(x) *
 * ((|x| + 2^(d-1)) >> d), reconstruction q << d, |x - (q << d)| <= 2^(d-1). */
static inline int16_t ad_drop(int16_t x, int bits) {
    if (bits <= 0)
        return x;
    int32_t v = x, half = (int32_t)1 << (bits - 1);
    return (int16_t)(v >= 0 ? (v + half) >> bits : -(((-v) + half) >> bits));
}
static inline uint64_t ad_drop_bound(int level) {
    return level ? (uint64_t)1 << (level - 1) : 0;
}
