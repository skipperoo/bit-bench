#!/usr/bin/env python3
"""BitBench example compressor: delta + zigzag LEB128.

Reads a .bin integer sequence (8- or 16-byte header), compresses it, and
writes the standard BitBench result CSV. See docs/user-compressors.md.
"""

import json
import os
import struct
import sys
import time

NAME = "example_delta_py"
HEADER = (
    "compressor,dataset,num_values,original_size,memory_usage,"
    "uncompressed_bits,compressed_bits,compression_ratio,"
    "compression_throughput_mbs,decompression_throughput_mbs,"
    "random_access_ns,random_access_mbs"
)


def parse_args(argv):
    options = {"mode": "delta", "verify": True}
    flags = {}
    out_path = None
    in_path = None
    options_path = None

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "-o" and i + 1 < len(argv):
            out_path = argv[i + 1]
            i += 2
        elif arg == "--options" and i + 1 < len(argv):
            options_path = argv[i + 1]
            i += 2
        elif arg.startswith("--") and "=" in arg:
            key, value = arg[2:].split("=", 1)
            flags[key] = value
            i += 1
        else:
            in_path = arg
            i += 1

    if "mode" in flags:
        options["mode"] = flags["mode"]
    if "verify" in flags:
        options["verify"] = flags["verify"].lower() == "true"

    # The JSON file takes precedence over the individual flags.
    if options_path and os.path.exists(options_path):
        with open(options_path) as handle:
            options.update(json.load(handle))

    return out_path, in_path, options


def read_bin(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    if len(raw) < 8:
        raise ValueError("input file too small")

    (count,) = struct.unpack_from("<Q", raw, 0)
    offset = 8
    if len(raw) == 16 + count * 8:
        offset = 16
    elif len(raw) != 8 + count * 8:
        raise ValueError("input size does not match either .bin header format")

    if count == 0:
        return []
    return list(struct.unpack_from("<%dq" % count, raw, offset))


def zigzag_encode(value):
    return (value << 1) ^ (value >> 63)


def zigzag_decode(value):
    return (value >> 1) ^ -(value & 1)


def write_varint(buffer, value):
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            buffer.append(byte | 0x80)
        else:
            buffer.append(byte)
            return


def read_varint(data, index):
    result = 0
    shift = 0
    while True:
        byte = data[index]
        index += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, index
        shift += 7


def compress(values, mode):
    buffer = bytearray()
    previous = 0
    for value in values:
        delta = value if mode == "raw" else value - previous
        previous = value
        write_varint(buffer, zigzag_encode(delta))
    return bytes(buffer)


def decompress(blob, mode):
    data = list(blob)
    values = []
    index = 0
    previous = 0
    while index < len(data):
        encoded, index = read_varint(data, index)
        delta = zigzag_decode(encoded)
        value = delta if mode == "raw" else previous + delta
        values.append(value)
        previous = value
    return values


def main():
    out_path, in_path, options = parse_args(sys.argv[1:])
    if not out_path or not in_path:
        sys.exit("usage: main.py -o <out.csv> [--options <opts.json>] <input.bin>")

    values = read_bin(in_path)
    count = len(values)

    started = time.perf_counter()
    blob = compress(values, options["mode"])
    compressed_at = time.perf_counter()

    if options["verify"]:
        if decompress(blob, options["mode"]) != values:
            sys.exit("round-trip verification failed")
    verified_at = time.perf_counter()

    original_size = count * 8
    uncompressed_bits = count * 64
    compressed_bits = len(blob) * 8
    ratio = compressed_bits / uncompressed_bits if uncompressed_bits else 0.0
    compress_mbs = (original_size / 1048576) / (compressed_at - started) if compressed_at > started else 0.0
    decompress_mbs = (original_size / 1048576) / (verified_at - compressed_at) if verified_at > compressed_at else 0.0

    line = "%s,example,%d,%d,,%d,%d,%.6f,%.3f,%.3f,," % (
        NAME, count, original_size, uncompressed_bits, compressed_bits, ratio,
        compress_mbs, decompress_mbs,
    )

    with open(out_path, "w") as handle:
        handle.write(HEADER + "\n" + line + "\n")


if __name__ == "__main__":
    main()
