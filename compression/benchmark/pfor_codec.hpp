// Construction of a single FastPFor codec by name.
// FastPForLib::CODECFactory instantiates every codec of the library (~30, some with
// large internal buffers), which Massif would attribute to PForDelta. Building only the
// requested codec keeps the measured memory to what the algorithm actually needs.
#pragma once

#include <array>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include <headers/codecfactory.h>

inline std::shared_ptr<FastPForLib::IntegerCODEC> make_pfor_codec(const std::string &name) {
    using Maker = std::unique_ptr<FastPForLib::IntegerCODEC> (*)();
    // Plain array instead of a std::map, so that the lookup itself does not allocate.
    static constexpr std::array<std::pair<const char *, Maker>, 13> makers{{
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
    }};
    for (const auto &[codec_name, make] : makers) {
        if (name == codec_name) return make();
    }
    throw std::invalid_argument("Unknown PForDelta codec: " + name);
}
