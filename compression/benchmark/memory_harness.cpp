
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <filesystem>
#include <algorithm>
#include <chrono>
#include <iomanip>
#include <utility>

#include "benchmark_common.hpp"

// SDSL includes
#include <sdsl/bit_vectors.hpp>
#include <sdsl/dac_vector.hpp>

// Local includes
#include "NeaTS/NeaTS.hpp"
#include "NeaTS/algorithms.hpp"

// Streaming compressors
#include "Chimp/CompressorChimp.hpp"
#include "Chimp128/CompressorChimp128.hpp"
#include "TSXor/CompressorTSXor.hpp"
#include "Gorilla/CompressorGorilla.hpp"
#include "Elf/CompressorElf.hpp"
#include "Camel/CompressorCamel.hpp"
#include "Falcon/CompressorFalcon.hpp"

// GEF includes
#include "gef/gef.hpp"

// FastPFOR for PForDelta memory benchmarking
#include <headers/fastpfor.h>
#include <headers/codecfactory.h>

using namespace FastPForLib;

// GZip compression via gzip-hpp (header-only, wraps zlib)
#ifdef HAS_GZIP
#include <gzip/compress.hpp>
#include <gzip/decompress.hpp>
#endif

#ifdef HAS_BZIP3
#include <libbz3.h>
#endif

// Squash compression library (optional)
#ifdef USE_SQUASH
#include <squash/squash.h>
#define HAS_SQUASH 1
#else
#define HAS_SQUASH 0
#endif

static constexpr size_t GEF_UNIFORM_PARTITION_SIZE = 32000;

// Massif phase marker: lets scripts detect snapshots taken *after* READY_FOR_COMPRESSION.
// We subtract this constant back out in the parsing script.
static constexpr size_t MASSIF_PHASE_MARKER_BYTES = 64 * 1024;
static volatile uint8_t* g_massif_phase_marker = nullptr;

#if defined(__GNUC__) || defined(__clang__)
#define GEF_NOINLINE __attribute__((noinline))
#else
#define GEF_NOINLINE
#endif

static GEF_NOINLINE void massif_phase_marker_begin() {
    if (g_massif_phase_marker != nullptr) return;
    auto* p = new uint8_t[MASSIF_PHASE_MARKER_BYTES];
    p[0] = 1;
    g_massif_phase_marker = p;
    do_not_optimize(p);
}

static GEF_NOINLINE void massif_phase_marker_end() {
    auto* p = const_cast<uint8_t*>(g_massif_phase_marker);
    delete[] p;
    g_massif_phase_marker = nullptr;
}
#undef GEF_NOINLINE

struct MassifPhaseMarkerGuard {
    MassifPhaseMarkerGuard() { massif_phase_marker_begin(); }
    ~MassifPhaseMarkerGuard() { massif_phase_marker_end(); }
};

// ============================================================================
// Utility functions
// ============================================================================

struct LoadedDataset {
    std::vector<int64_t> data;
    int64_t decimals;
};

LoadedDataset load_custom_dataset(const std::string& filename) {
    std::ifstream in(filename, std::ios::binary);
    if (!in) {
        throw std::runtime_error("Cannot open file: " + filename);
    }

    uint64_t n_val = 0;
    in.read(reinterpret_cast<char*>(&n_val), 8);
    size_t n = static_cast<size_t>(n_val);
    
    in.seekg(0, std::ios::end);
    size_t file_size = in.tellg();
    in.seekg(8, std::ios::beg); // Skip N
    
    size_t expected_size_new = 8 + 8 + n * 8;
    size_t expected_size_old = 8 + n * 8;
    
    int64_t x = 0;
    std::vector<int64_t> data(n);
    
    if (file_size == expected_size_new) {
        uint64_t x_val = 0;
        in.read(reinterpret_cast<char*>(&x_val), 8);
        x = static_cast<int64_t>(x_val);
    } else if (file_size == expected_size_old) {
        x = 0;
    }
    
    in.read(reinterpret_cast<char*>(data.data()), n * 8);
    
    return {std::move(data), x};
}

// ============================================================================
// Utility: int-to-bytes conversion (from lossless_benchmark.cpp)
// ============================================================================

template<class T>
const auto to_bytes = [](auto &&x) -> std::array<uint8_t, sizeof(T)> {
    std::array<uint8_t, sizeof(T)> arrayOfByte{};
    for (size_t i = 0; i < sizeof(T); i++)
        arrayOfByte[(sizeof(T) - 1) - i] = (x >> (i * 8));
    return arrayOfByte;
};

// ============================================================================
// Compression Wrappers (Simplified for Memory measurement)
// ============================================================================

template<typename T, typename T1_coeff>
void run_neats(const std::vector<T> &processed_data, uint8_t max_bpc) {
    pfa::neats::compressor<uint64_t, T, double, T1_coeff, double> compressor(max_bpc);
    compressor.partitioning(processed_data.begin(), processed_data.end());
    do_not_optimize(compressor);
}

template<typename GEFType, typename T = int64_t>
void run_gef(const std::vector<T> &data) {
    GEFType compressor(data);
    do_not_optimize(compressor);
}

template<typename T = int64_t>
void run_dac(const std::vector<T> &data) {
    std::vector<uint64_t> u_data(data.size());
    std::transform(data.begin(), data.end(), u_data.begin(),
                   [](int64_t x) { return static_cast<uint64_t>(x); });
    sdsl::dac_vector_dp<> dac_vector(u_data);
    do_not_optimize(dac_vector);
}

template<typename Compressor, typename T>
void run_bitstream_compressor(const std::vector<T> &data, size_t block_size) {
    const size_t n = data.size();
    if (n == 0) return;
    const size_t num_blocks = n / block_size + (n % block_size != 0);
    
    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        if (start >= end) continue;
        
        Compressor cmpr(data[start]);
        for (size_t i = start + 1; i < end; ++i) {
            cmpr.addValue(data[i]);
        }
        cmpr.close();
        do_not_optimize(cmpr);
    }
}

template<typename T>
void run_tsxor(const std::vector<T> &data, size_t block_size) {
    const size_t n = data.size();
    if (n == 0) return;
    const size_t num_blocks = n / block_size + (n % block_size != 0);
    
    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        if (start >= end) continue;
        
        CompressorTSXor<T> cmpr(data[start]);
        for (size_t i = start + 1; i < end; ++i) {
            cmpr.addValue(data[i]);
        }
        cmpr.close();
        do_not_optimize(cmpr);
    }
}

template<typename T>
void run_falcon(const std::vector<T> &data, size_t block_size) {
    const size_t n = data.size();
    if (n == 0) return;
    const size_t num_blocks = n / block_size + (n % block_size != 0);
    
    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        if (start >= end) continue;
        
        CompressorFalcon<T> cmpr(data[start], end - start);
        for (size_t i = start + 1; i < end; ++i) {
            cmpr.addValue(data[i]);
        }
        cmpr.close();
        do_not_optimize(cmpr);
    }
}

template<typename T = int64_t>
void run_pfordelta(const std::string &codec_name, const std::vector<T> &data, size_t block_size) {
    const size_t n = data.size();
    if (n == 0) return;
    const size_t num_blocks = (n + block_size - 1) / block_size;

    CODECFactory factory;
    auto codec = factory.getFromName(codec_name);

    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        size_t bs = end - start;

        std::vector<uint32_t> block_data(bs);
        for (size_t i = 0; i < bs; ++i)
            block_data[i] = static_cast<uint32_t>(data[start + i]);

        for (size_t i = bs - 1; i > 0; --i)
            block_data[i] -= block_data[i - 1];

        std::vector<uint32_t> compressed(bs + 1024);
        size_t compressed_size = compressed.size();
        codec->encodeArray(block_data.data(), bs, compressed.data(), compressed_size);
        do_not_optimize(compressed);
    }
}

#ifdef HAS_GZIP
template<typename T = int64_t>
void run_gzip(const std::vector<T> &data, size_t block_size, int level) {
    const size_t n = data.size();
    if (n == 0) return;
    const size_t num_blocks = (n + block_size - 1) / block_size;

    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        size_t bs = end - start;

        std::vector<uint8_t> data_bytes;
        data_bytes.reserve(bs * sizeof(T));
        for (size_t i = start; i < end; ++i) {
            auto bytes = to_bytes<T>(data[i]);
            data_bytes.insert(data_bytes.end(), bytes.begin(), bytes.end());
        }

        std::string compressed = gzip::compress(
            reinterpret_cast<const char*>(data_bytes.data()), data_bytes.size(), level);
        do_not_optimize(compressed);
    }
}
#endif

#ifdef HAS_BZIP3
template<typename T = int64_t>
void run_bzip3(const std::vector<T> &data, size_t block_size, int level) {
    const size_t n = data.size();
    if (n == 0) return;
    const size_t num_blocks = (n + block_size - 1) / block_size;
    // Map level 1-9 to block size in bytes
    const uint32_t bz3_block_size = static_cast<uint32_t>(std::max(1, std::min(9, level))) * 65536u;

    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        size_t bs = end - start;

        std::vector<uint8_t> data_bytes;
        data_bytes.reserve(bs * sizeof(T));
        for (size_t i = start; i < end; ++i) {
            auto bytes = to_bytes<T>(data[i]);
            data_bytes.insert(data_bytes.end(), bytes.begin(), bytes.end());
        }

        size_t out_size = bz3_bound(data_bytes.size());
        std::vector<uint8_t> compressed(out_size);

        bz3_compress(bz3_block_size, data_bytes.data(), compressed.data(), data_bytes.size(), &out_size);
        do_not_optimize(compressed);
    }
}
#endif

#if HAS_SQUASH
template<typename T = int64_t>
void run_squash(const std::string &compressor_name, const std::vector<T> &data, size_t block_size, int level = -1) {
    SquashCodec *codec = squash_get_codec(compressor_name.c_str());
    if (codec == nullptr) return;
    
    SquashOptions *opts = nullptr;
    if (level != -1) {
        char level_s[4];
        opts = squash_options_new(codec, NULL);
        squash_object_ref_sink(opts);
        snprintf(level_s, 4, "%d", level);
        squash_options_parse_option(opts, "level", level_s);
    }
    
    const size_t n = data.size();
    const size_t num_blocks = n / block_size + (n % block_size != 0);
    
    size_t max_compressed_size = squash_codec_get_max_compressed_size(codec, block_size * sizeof(T));
    std::vector<uint8_t> compressed_buffer(max_compressed_size);
    
    for (size_t ib = 0; ib < num_blocks; ++ib) {
        size_t start = ib * block_size;
        size_t end = std::min(start + block_size, n);
        size_t current_block_size = (end - start) * sizeof(T);
        
        size_t compressed_size = max_compressed_size;
        squash_codec_compress_with_options(codec, &compressed_size, compressed_buffer.data(), 
                              current_block_size, reinterpret_cast<const uint8_t*>(data.data() + start), opts);
        do_not_optimize(compressed_buffer);
    }
    
    if (opts != nullptr) {
        squash_object_unref(opts);
    }
}
#endif

// ============================================================================
// Main
// ============================================================================

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "Usage: " << argv[0] << " <input_file> -c <compressor> [options]" << std::endl;
        return 1;
    }
    
    std::string input_path = argv[1];
    std::string compressor_name;
    size_t block_size = 1000;
    uint8_t max_bpc = 32;
    
    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "-c" && i + 1 < argc) {
            compressor_name = argv[++i];
        } else if (arg == "-b" && i + 1 < argc) {
            block_size = std::stoul(argv[++i]);
        } else if (arg == "-m" && i + 1 < argc) {
            max_bpc = std::stoi(argv[++i]);
        }
    }
    
    if (compressor_name.empty()) {
        std::cerr << "Error: Compressor not specified (-c <name>)" << std::endl;
        return 1;
    }
    
    // Load dataset
    LoadedDataset loaded = load_custom_dataset(input_path);
    size_t n = loaded.data.size();
    
    // Print input buffer size for the user/scripts to see
    std::cout << "input_buffer_bytes: " << n * sizeof(int64_t) << std::endl;
    std::cout << "num_values: " << n << std::endl;
    std::cout << "compressor: " << compressor_name << std::endl;
    
    // Prepare BenchmarkData (simplified)
    BenchmarkData bench_data;
    bench_data.filename = input_path;
    bench_data.decimals = loaded.decimals;
    bench_data.uncompressed_bits = n * sizeof(int64_t) * 8;
    
    // Parse =LEVEL suffix from compressor name
    std::string base_name = compressor_name;
    int level = 6;  // default level for dictionary-based compressors
    {
        auto eq_pos = compressor_name.find('=');
        if (eq_pos != std::string::npos) {
            base_name = compressor_name.substr(0, eq_pos);
            level = std::stoi(compressor_name.substr(eq_pos + 1));
        }
    }
    
    // Identify needed data format
    bool needs_shifted = false;
    bool needs_double = false;
    bool needs_raw = false;

    // Baseline modes: build the same input representation but do not run any compressor.
    // Used by Massif measurement scripts to subtract fixed runtime/preprocessing overhead.
    if (base_name == "baseline_shifted") {
        needs_shifted = true;
    } else if (base_name == "baseline_double") {
        needs_double = true;
    } else if (base_name == "baseline_raw") {
        needs_raw = true;
    } else if (base_name == "neats" || base_name == "dac" ||
               base_name.find("_gef") != std::string::npos ||
               base_name == "leco" || base_name == "pfordelta" ||
               base_name.find("pfordelta_") == 0) {
        needs_shifted = true;
    } else if (base_name == "alp" || base_name == "gorilla" ||
               base_name == "chimp" || base_name == "chimp128" ||
               base_name == "tsxor" || base_name == "elf" ||
               base_name == "camel" || base_name == "falcon") {
        needs_double = true;
    } else {
        needs_raw = true;
    }

    const char* data_format = needs_double ? "double" : (needs_shifted ? "shifted" : "raw");
    std::cout << "data_format: " << data_format << std::endl;
    
    // Process data
    if (needs_shifted || needs_double) {
        auto min_data = *std::min_element(loaded.data.begin(), loaded.data.end());
        int64_t min_val = min_data < 0 ? (min_data - 1) : -1;
        bench_data.min_val = min_val;
        
        // Shift in-place and move to avoid a transient "two full copies" peak during preprocessing.
        for (size_t i = 0; i < n; ++i) {
            loaded.data[i] -= min_val;
        }
        bench_data.shifted_data = std::move(loaded.data);

        if (needs_double) {
            bench_data.convert_shifted_to_double();
        }
    } else {
        bench_data.raw_data = std::move(loaded.data);
    }
    
    // Final memory report before starting compression
    std::cout << "READY_FOR_COMPRESSION" << std::endl;

    // Phase marker for Massif parsing: allocated only after READY_FOR_COMPRESSION.
    MassifPhaseMarkerGuard massif_guard;

    // Run compression
    if (base_name == "baseline_shifted") {
        do_not_optimize(bench_data.shifted_data);
    } else if (base_name == "baseline_double") {
        do_not_optimize(bench_data.double_data);
    } else if (base_name == "baseline_raw") {
        do_not_optimize(bench_data.raw_data);
    } else if (base_name == "neats") {
        int64_t max_val = *std::max_element(bench_data.shifted_data.begin(), bench_data.shifted_data.end());
        if (max_val > 1000000) {
            run_neats<int64_t, double>(bench_data.shifted_data, max_bpc);
        } else {
            run_neats<int64_t, float>(bench_data.shifted_data, max_bpc);
        }
    } else if (base_name == "dac") {
        run_dac<int64_t>(bench_data.shifted_data);
    } else if (base_name == "rle_gef") {
        run_gef<gef::RLE_GEF<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "u_gef_approximate") {
        run_gef<gef::U_GEF_APPROXIMATE<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "u_gef_optimal") {
        run_gef<gef::U_GEF<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "b_gef_approximate") {
        run_gef<gef::B_GEF_APPROXIMATE<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "b_gef_optimal") {
        run_gef<gef::B_GEF<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "b_star_gef_approximate") {
        run_gef<gef::B_STAR_GEF_APPROXIMATE<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "b_star_gef_optimal") {
        run_gef<gef::B_STAR_GEF<int64_t, GEF_UNIFORM_PARTITION_SIZE>>(bench_data.shifted_data);
    } else if (base_name == "gorilla") {
        run_bitstream_compressor<CompressorGorilla<double>, double>(bench_data.double_data, block_size);
    } else if (base_name == "chimp") {
        run_bitstream_compressor<CompressorChimp<double>, double>(bench_data.double_data, block_size);
    } else if (base_name == "chimp128") {
        run_bitstream_compressor<CompressorChimp128<double>, double>(bench_data.double_data, block_size);
    } else if (base_name == "tsxor") {
        run_tsxor<double>(bench_data.double_data, block_size);
    } else if (base_name == "elf") {
        run_bitstream_compressor<CompressorElf<double>, double>(bench_data.double_data, block_size);
    } else if (base_name == "camel") {
        run_bitstream_compressor<CompressorCamel<double>, double>(bench_data.double_data, block_size);
    } else if (base_name == "falcon") {
        run_falcon<double>(bench_data.double_data, block_size);
    } else if (base_name == "alp") {
        benchmark_alp(bench_data, {});
    } else if (base_name == "pfordelta" || base_name.find("pfordelta_") == 0) {
        std::string codec_name = "simdnewpfor";
        if (base_name.find("pfordelta_") == 0)
            codec_name = base_name.substr(10);
        run_pfordelta(codec_name, bench_data.shifted_data, block_size);
    } else if (base_name == "gzip") {
#ifdef HAS_GZIP
        run_gzip(bench_data.raw_data, block_size, level);
#else
        std::cerr << "Error: gzip not available (HAS_GZIP=0)" << std::endl;
        return 1;
#endif
    } 
#if defined(NEATS_ENABLE_LECO)
    else if (base_name == "leco") {
        benchmark_leco(bench_data, {}, block_size);
    }
#endif
#if HAS_SQUASH
    else if (base_name == "bzip3") {
#ifdef HAS_BZIP3
        run_bzip3(bench_data.raw_data, block_size, level);
#else
        std::cerr << "Error: bzip3 not available (HAS_BZIP3=0)" << std::endl;
        return 1;
#endif
    } else if (base_name == "lz4" || base_name == "zstd" || 
             base_name == "brotli" || base_name == "xz" || 
             base_name == "snappy" || base_name == "bzip2") {
        run_squash(base_name, bench_data.raw_data, block_size, level);
    }
#endif
    else {
        std::cerr << "Error: Unknown compressor " << compressor_name << std::endl;
        return 1;
    }
    
    std::cout << "DONE_COMPRESSION" << std::endl;
    
    return 0;
}
