// BitBench example compressor: delta + zigzag LEB128 (C++).
// See docs/user-compressors.md for the package and output contract.
#include <chrono>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

static const char *kName = "example_delta_cpp";
static const char *kCsvHeader =
    "compressor,dataset,num_values,original_size,memory_usage,"
    "uncompressed_bits,compressed_bits,compression_ratio,"
    "compression_throughput_mbs,decompression_throughput_mbs,"
    "random_access_ns,random_access_mbs";

struct Options {
    std::string mode = "delta";
    bool verify = true;
};

static double now_seconds() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double>(clock::now().time_since_epoch()).count();
}

static uint64_t zigzag_encode(int64_t value) {
    return (static_cast<uint64_t>(value) << 1) ^ static_cast<uint64_t>(value >> 63);
}

static int64_t zigzag_decode(uint64_t value) {
    return static_cast<int64_t>(value >> 1) ^ -static_cast<int64_t>(value & 1);
}

static void write_varint(std::vector<uint8_t> &out, uint64_t value) {
    while (value >= 0x80) {
        out.push_back(static_cast<uint8_t>(value | 0x80));
        value >>= 7;
    }
    out.push_back(static_cast<uint8_t>(value));
}

static uint64_t read_varint(const std::vector<uint8_t> &in, size_t &index) {
    uint64_t result = 0;
    int shift = 0;
    for (;;) {
        uint8_t byte = in[index++];
        result |= static_cast<uint64_t>(byte & 0x7F) << shift;
        if ((byte & 0x80) == 0) {
            return result;
        }
        shift += 7;
    }
}

static std::string read_file(const std::string &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return {};
    }
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

static void apply_json_options(const std::string &path, Options &opts) {
    std::string json = read_file(path);
    if (json.empty()) {
        return;
    }

    auto mode_pos = json.find("\"mode\"");
    if (mode_pos != std::string::npos) {
        auto colon = json.find(':', mode_pos);
        auto quote = colon == std::string::npos ? std::string::npos : json.find('"', colon);
        if (quote != std::string::npos) {
            auto end = json.find('"', quote + 1);
            if (end != std::string::npos) {
                opts.mode = json.substr(quote + 1, end - quote - 1);
            }
        }
    }

    auto verify_pos = json.find("\"verify\"");
    if (verify_pos != std::string::npos) {
        auto colon = json.find(':', verify_pos);
        if (colon != std::string::npos) {
            opts.verify = json.compare(colon + 1, 4, "true") == 0 ||
                          json.compare(colon + 2, 4, "true") == 0;
        }
    }
}

static bool read_bin(const std::string &path, std::vector<int64_t> &values) {
    std::string raw = read_file(path);
    if (raw.size() < 8) {
        return false;
    }

    uint64_t count = 0;
    std::memcpy(&count, raw.data(), 8);
    size_t offset = 8;
    if (raw.size() == 16 + count * 8) {
        offset = 16;
    } else if (raw.size() != 8 + count * 8) {
        return false;
    }

    values.resize(count);
    if (count > 0) {
        std::memcpy(values.data(), raw.data() + offset, count * 8);
    }
    return true;
}

int main(int argc, char **argv) {
    Options opts;
    std::string out_path;
    std::string in_path;
    std::string options_path;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "-o" && i + 1 < argc) {
            out_path = argv[++i];
        } else if (arg == "--options" && i + 1 < argc) {
            options_path = argv[++i];
        } else if (arg.rfind("--mode=", 0) == 0) {
            opts.mode = arg.substr(7);
        } else if (arg.rfind("--verify=", 0) == 0) {
            opts.verify = arg.substr(9) == "true";
        } else if (!arg.empty() && arg[0] != '-') {
            in_path = arg;
        }
    }

    if (!options_path.empty()) {
        apply_json_options(options_path, opts);
    }
    if (out_path.empty() || in_path.empty()) {
        std::cerr << "usage: codec -o <out.csv> [--options <opts.json>] <input.bin>\n";
        return 1;
    }

    std::vector<int64_t> values;
    if (!read_bin(in_path, values)) {
        std::cerr << "cannot read input " << in_path << "\n";
        return 1;
    }

    std::vector<uint8_t> compressed;
    compressed.reserve(values.size() * 5 + 16);

    double started = now_seconds();
    int64_t previous = 0;
    for (int64_t value : values) {
        int64_t delta = opts.mode == "raw" ? value : value - previous;
        previous = value;
        write_varint(compressed, zigzag_encode(delta));
    }
    double compressed_at = now_seconds();

    if (opts.verify) {
        size_t index = 0;
        previous = 0;
        for (size_t i = 0; i < values.size(); ++i) {
            int64_t delta = zigzag_decode(read_varint(compressed, index));
            int64_t value = opts.mode == "raw" ? delta : previous + delta;
            if (value != values[i]) {
                std::cerr << "round-trip verification failed at " << i << "\n";
                return 1;
            }
            previous = value;
        }
    }
    double verified_at = now_seconds();

    size_t count = values.size();
    size_t original_size = count * 8;
    size_t uncompressed_bits = count * 64;
    size_t compressed_bits = compressed.size() * 8;
    double ratio = uncompressed_bits ? static_cast<double>(compressed_bits) / uncompressed_bits : 0.0;
    double compress_mbs = compressed_at > started
        ? (static_cast<double>(original_size) / 1048576.0) / (compressed_at - started) : 0.0;
    double decompress_mbs = verified_at > compressed_at
        ? (static_cast<double>(original_size) / 1048576.0) / (verified_at - compressed_at) : 0.0;

    std::ofstream out(out_path);
    if (!out) {
        std::cerr << "cannot write output " << out_path << "\n";
        return 1;
    }
    out << kCsvHeader << "\n";
    out.setf(std::ios::fixed);
    out.precision(6);
    out << kName << ",example," << count << "," << original_size << ",,"
        << uncompressed_bits << "," << compressed_bits << "," << ratio << ",";
    out.precision(3);
    out << compress_mbs << "," << decompress_mbs << ",,\n";
    return 0;
}
