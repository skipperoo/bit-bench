
#include <iostream>
#include <fstream>
#include <chrono>
#include <vector>
#include <string>
#include <filesystem>
#include <algorithm>
#include <iomanip>

#include "benchmark_common.hpp"
#include <headers/fastpfor.h>
#include <headers/codecfactory.h>

using namespace FastPForLib;

// ============================================================================
// Utility functions (Replicated from lossless_benchmark.cpp)
// ============================================================================

std::string extract_filename(const std::string &path) {
    return std::filesystem::path(path).filename().string();
}

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
    
    return {data, x};
}

void BenchmarkResult::print_header(std::ostream &out) const {
    out << "compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,"
        << "compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,"
        << "random_access_ns,random_access_mbs";
    for (const auto &[range, _] : range_query_throughputs) {
        out << ",range_" << range << "_mbs";
    }
    out << std::endl;
}

void BenchmarkResult::print(std::ostream &out) const {
    out << std::fixed << std::setprecision(4);
    const size_t original_size_bytes = (original_size > 0) ? original_size : ((uncompressed_bits + 7) / 8);
    out << compressor << "," << extract_filename(dataset) << "," << num_values << ","
        << original_size_bytes << "," << memory_usage << ","
        << uncompressed_bits << "," << compressed_bits << ","
        << compression_ratio << "," << compression_throughput_mbs << ","
        << decompression_throughput_mbs << "," << random_access_ns << "," << random_access_mbs;
    for (const auto &[_, throughput] : range_query_throughputs) {
        out << "," << throughput;
    }
    out << std::endl;
}

// ============================================================================
// PForDelta Benchmark
// ============================================================================

BenchmarkResult benchmark_pfordelta(const std::string &codec_name,
                                    const std::vector<int64_t> &raw_data,
                                    const std::string &filename) {
    BenchmarkResult result;
    result.compressor = "pfordelta_" + codec_name;
    result.dataset = filename;
    result.num_values = raw_data.size();
    result.uncompressed_bits = raw_data.size() * sizeof(int64_t) * 8;
    result.original_size = raw_data.size() * sizeof(int64_t);

    if (raw_data.empty()) return result;

    // FastPFOR works on uint32_t. We need to cast and apply Delta.
    // NOTE: PForDelta implies Delta encoding.
    std::vector<uint32_t> data(raw_data.size());
    for (size_t i = 0; i < raw_data.size(); ++i) {
        data[i] = static_cast<uint32_t>(raw_data[i]);
    }

    // Apply Delta
    std::vector<uint32_t> delta_data = data;
    for (size_t i = delta_data.size() - 1; i > 0; --i) {
        delta_data[i] -= delta_data[i - 1];
    }

    CODECFactory factory;
    auto codec = factory.getFromName(codec_name);
    
    // Compression
    std::vector<uint32_t> compressed(raw_data.size() + 1024);
    size_t compressed_size = compressed.size();
    
    auto t1 = std::chrono::high_resolution_clock::now();
    codec->encodeArray(delta_data.data(), delta_data.size(), compressed.data(), compressed_size);
    auto t2 = std::chrono::high_resolution_clock::now();
    
    compressed.resize(compressed_size);
    result.compressed_bits = compressed_size * sizeof(uint32_t) * 8;
    result.compression_ratio = static_cast<double>(result.compressed_bits) / result.uncompressed_bits;
    
    auto comp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t2 - t1).count();
    result.compression_throughput_mbs = (raw_data.size() * sizeof(int64_t) / 1024.0 / 1024.0) / (comp_ns / 1e9);

    // Decompression
    std::vector<uint32_t> decompressed(raw_data.size());
    size_t decompressed_size = decompressed.size();
    
    t1 = std::chrono::high_resolution_clock::now();
    codec->decodeArray(compressed.data(), compressed.size(), decompressed.data(), decompressed_size);
    
    // Inverse Delta
    for (size_t i = 1; i < decompressed.size(); ++i) {
        decompressed[i] += decompressed[i - 1];
    }
    t2 = std::chrono::high_resolution_clock::now();
    
    auto decomp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t2 - t1).count();
    result.decompression_throughput_mbs = (raw_data.size() * sizeof(int64_t) / 1024.0 / 1024.0) / (decomp_ns / 1e9);

    // Verify
    for (size_t i = 0; i < raw_data.size(); ++i) {
        if (decompressed[i] != data[i]) {
            std::cerr << "Verification failed at index " << i << std::endl;
            break;
        }
    }

    // Random Access (Simulated as full decompression of the block since FastPFOR doesn't support it directly)
    // In a real scenario, one would use blocks, but for this benchmark we report 0 or simulate.
    result.random_access_ns = 0; 
    result.random_access_mbs = 0;

    return result;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <input_file> [-o output_file] [-c codec]" << std::endl;
        return 1;
    }

    std::string input_path = argv[1];
    std::string output_path;
    std::string codec_name = "pfor"; // Default

    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "-o" && i + 1 < argc) {
            output_path = argv[++i];
        } else if (arg == "-c" && i + 1 < argc) {
            codec_name = argv[++i];
        }
    }

    try {
        LoadedDataset loaded = load_custom_dataset(input_path);
        BenchmarkResult result = benchmark_pfordelta(codec_name, loaded.data, input_path);

        std::ostream *out = &std::cout;
        std::ofstream file_out;
        if (!output_path.empty()) {
            file_out.open(output_path, std::ios::app);
            if (file_out.is_open()) {
                out = &file_out;
            }
        }

        // If file is empty or new, print header
        bool print_header = true;
        if (!output_path.empty()) {
            std::ifstream check_file(output_path);
            if (check_file.peek() != std::ifstream::traits_type::eof()) {
                print_header = false;
            }
        }
        
        if (print_header) {
            result.print_header(*out);
        }
        result.print(*out);

    } catch (const std::exception &e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
