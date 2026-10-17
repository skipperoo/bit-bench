#pragma once

// Parsing of native benchmark `-c` entries.
//
// An entry is one of:
//   name                              (no options)
//   name=LEVEL                        (legacy: single integer level)
//   name=key:value;key:value          (extended options)
//
// Comma separates entries, so neither keys nor values may contain a comma.
// Unknown keys are ignored.

#include <cctype>
#include <climits>
#include <sstream>
#include <string>

namespace bench {

struct CompressorSpec {
    std::string name;                    // base compressor name
    int level = -1;                      // -1 = library default
    int max_bpc = 32;                    // NeaTS
    bool max_bpc_set = false;            // whether max_bpc was explicitly given
    bool lossy = false;                  // NeaTS
    int max_precision = INT_MIN;         // Camel; INT_MIN = unset (benchmark default)
    int decimals = INT_MIN;              // Falcon; INT_MIN = unset (use .bin header)
    std::string codec = "simdnewpfor";   // PForDelta

    bool has_max_precision() const { return max_precision != INT_MIN; }
    bool has_decimals() const { return decimals != INT_MIN; }
};

inline CompressorSpec parse_compressor_spec(const std::string &input, int default_level = -1) {
    CompressorSpec spec;
    const auto eq = input.find('=');
    if (eq == std::string::npos) {
        spec.name = input;
        spec.level = default_level;
        return spec;
    }

    spec.name = input.substr(0, eq);
    const std::string rest = input.substr(eq + 1);

    // Legacy form: name=<integer> selects the level.
    bool numeric = !rest.empty();
    for (char ch : rest) {
        if (!std::isdigit(static_cast<unsigned char>(ch)) && ch != '-') {
            numeric = false;
            break;
        }
    }
    if (numeric) {
        spec.level = std::stoi(rest);
        return spec;
    }

    std::stringstream stream(rest);
    std::string pair;
    while (std::getline(stream, pair, ';')) {
        const auto colon = pair.find(':');
        if (colon == std::string::npos) {
            continue;
        }
        const std::string key = pair.substr(0, colon);
        const std::string value = pair.substr(colon + 1);
        try {
            if (key == "level") {
                spec.level = std::stoi(value);
            } else if (key == "max_bpc") {
                spec.max_bpc = std::stoi(value);
                spec.max_bpc_set = true;
            } else if (key == "lossy") {
                spec.lossy = (value == "true" || value == "1");
            } else if (key == "max_precision") {
                spec.max_precision = std::stoi(value);
            } else if (key == "decimals") {
                spec.decimals = std::stoi(value);
            } else if (key == "codec") {
                spec.codec = value;
            }
        } catch (...) {
            // Ignore malformed values; the compressor runs with its default.
        }
    }
    return spec;
}

} // namespace bench
