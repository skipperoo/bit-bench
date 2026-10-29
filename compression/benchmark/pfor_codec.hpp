// Construction of a single FastPFor codec by name.
// FastPForLib::CODECFactory instantiates every codec of the library (~30, some with
// large internal buffers), which Massif would attribute to PForDelta. Building only the
// requested codec keeps the measured memory to what the algorithm actually needs.
#pragma once

#include <array>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include <headers/codecfactory.h>

// Simple8b_RLE<true> and Simple9_RLE<true> write a 32-bit length word before the
// compressed words, but the size they report leaves it out (nvalue = count * 2 in
// simple8b_rle.h, nvalue = count in simple9_rle.h; still so in upstream FastPFor).
// The measured size was therefore one word short per encoded block, and decoding
// from exactly the reported size read past it. This wrapper adds the word back.
class PforLengthWordFix final : public FastPForLib::IntegerCODEC {
public:
    explicit PforLengthWordFix(std::unique_ptr<FastPForLib::IntegerCODEC> inner)
        : inner_(std::move(inner)) {}

    using FastPForLib::IntegerCODEC::encodeArray;
    using FastPForLib::IntegerCODEC::decodeArray;

    void encodeArray(const uint32_t *in, const size_t length, uint32_t *out,
                     size_t &nvalue) override {
        inner_->encodeArray(in, length, out, nvalue);
        ++nvalue;
    }

    const uint32_t *decodeArray(const uint32_t *in, const size_t length, uint32_t *out,
                                size_t &nvalue) override {
        return inner_->decodeArray(in, length, out, nvalue);
    }

    std::string name() const override { return inner_->name(); }

private:
    std::unique_ptr<FastPForLib::IntegerCODEC> inner_;
};

// Some decoders write whole words past the requested number of values (Simple9/16 up to
// 28 integers), so every decode buffer must have this many spare integers after its end.
// 32 was enough for all codecs on every Phase One chunk under AddressSanitizer.
inline constexpr size_t kPforDecodeSlack = 64;

// Names follow FastPForLib::CODECFactory, except "bp32" (factory name "BP32").
// Left out: "copy" (no compression), "snappy" and "varintg8iu" (only compiled with
// optional build flags of the library) and "vsencoding" (out-of-bounds read inside
// VSEncoding::compute_OptPartition, reported by AddressSanitizer).
inline std::shared_ptr<FastPForLib::IntegerCODEC> make_pfor_codec(const std::string &name) {
    using Maker = std::unique_ptr<FastPForLib::IntegerCODEC> (*)();
    // Plain array instead of a std::map, so that the lookup itself does not allocate.
    static constexpr std::array<std::pair<const char *, Maker>, 30> makers{{
        // Patched frame of reference
        {"simdnewpfor", FastPForLib::simdnewpfor_codec},
        {"newpfor", FastPForLib::newpfor_codec},
        {"simdpfor", FastPForLib::simdpfor_codec},
        {"pfor", FastPForLib::pfor_codec},
        {"pfor2008", FastPForLib::pfor2008_codec},
        {"simdoptpfor", FastPForLib::simdoptpfor_codec},
        {"optpfor", FastPForLib::optpfor_codec},
        {"simdsimplepfor", FastPForLib::simdsimplepfor_codec},
        {"simplepfor", FastPForLib::simplepfor_codec},
        {"simdfastpfor128", FastPForLib::simdfastpfor128_codec},
        {"simdfastpfor256", FastPForLib::simdfastpfor256_codec},
        {"fastpfor128", FastPForLib::fastpfor128_codec},
        {"fastpfor256", FastPForLib::fastpfor256_codec},
        // Binary packing
        {"fastbinarypacking8", FastPForLib::fastbinarypacking8_codec},
        {"fastbinarypacking16", FastPForLib::fastbinarypacking16_codec},
        {"fastbinarypacking32", FastPForLib::fastbinarypacking32_codec},
        {"bp32", FastPForLib::BP32_codec},
        {"simdbinarypacking", FastPForLib::simdbinarypacking_codec},
        // Variable byte
        {"varint", FastPForLib::varint_codec},
        {"vbyte", FastPForLib::vbyte_codec},
        {"maskedvbyte", FastPForLib::maskedvbyte_codec},
        {"streamvbyte", FastPForLib::streamvbyte_codec},
        {"varintgb", FastPForLib::varintgb_codec},
        // Word-aligned (Simple family)
        {"simple9", FastPForLib::simple9_codec},
        {"simple9_rle", FastPForLib::simple9_rle_codec},
        {"simple16", FastPForLib::simple16_codec},
        {"simple8b", FastPForLib::simple8b_codec},
        {"simple8b_rle", FastPForLib::simple8b_rle_codec},
        {"simdgroupsimple", FastPForLib::simdgroupsimple_codec},
        {"simdgroupsimple_ringbuf", FastPForLib::simdgroupsimple_ringbuf_codec},
    }};
    for (const auto &[codec_name, make] : makers) {
        if (name != codec_name) continue;
        if (name == "simple8b_rle" || name == "simple9_rle")
            return std::make_shared<PforLengthWordFix>(make());
        return make();
    }
    throw std::invalid_argument("Unknown PForDelta codec: " + name);
}
