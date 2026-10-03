// BitBench example compressor: delta + zigzag LEB128 (Go).
// See docs/user-compressors.md for the package and output contract.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

const name = "example_delta_go"

const csvHeader = "compressor,dataset,num_values,original_size,memory_usage," +
	"uncompressed_bits,compressed_bits,compression_ratio," +
	"compression_throughput_mbs,decompression_throughput_mbs," +
	"random_access_ns,random_access_mbs"

type options struct {
	Mode   string `json:"mode"`
	Verify *bool  `json:"verify"`
}

func zigzagEncode(value int64) uint64 {
	return uint64(value)<<1 ^ uint64(value>>63)
}

func zigzagDecode(value uint64) int64 {
	return int64(value>>1) ^ -int64(value&1)
}

func writeVarint(out []byte, value uint64) []byte {
	for value >= 0x80 {
		out = append(out, byte(value|0x80))
		value >>= 7
	}
	return append(out, byte(value))
}

func readVarint(in []byte, index *int) uint64 {
	var result uint64
	var shift uint
	for {
		b := in[*index]
		*index++
		result |= uint64(b&0x7F) << shift
		if b&0x80 == 0 {
			return result
		}
		shift += 7
	}
}

func main() {
	opts := options{Mode: "delta"}
	verify := true
	var outPath, inPath, optionsPath string

	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-o" && i+1 < len(args):
			outPath = args[i+1]
			i++
		case arg == "--options" && i+1 < len(args):
			optionsPath = args[i+1]
			i++
		case strings.HasPrefix(arg, "--mode="):
			opts.Mode = strings.TrimPrefix(arg, "--mode=")
		case strings.HasPrefix(arg, "--verify="):
			verify = strings.TrimPrefix(arg, "--verify=") == "true"
		case !strings.HasPrefix(arg, "-"):
			inPath = arg
		}
	}

	// The JSON file takes precedence over the individual flags.
	if optionsPath != "" {
		if data, err := os.ReadFile(optionsPath); err == nil {
			var fileOpts options
			if json.Unmarshal(data, &fileOpts) == nil {
				if fileOpts.Mode != "" {
					opts.Mode = fileOpts.Mode
				}
				if fileOpts.Verify != nil {
					verify = *fileOpts.Verify
				}
			}
		}
	}

	if outPath == "" || inPath == "" {
		fmt.Fprintln(os.Stderr, "usage: codec -o <out.csv> [--options <opts.json>] <input.bin>")
		os.Exit(1)
	}

	raw, err := os.ReadFile(inPath)
	if err != nil || len(raw) < 8 {
		fmt.Fprintf(os.Stderr, "cannot read input %s: %v\n", inPath, err)
		os.Exit(1)
	}

	count := binary.LittleEndian.Uint64(raw[:8])
	offset := uint64(8)
	if uint64(len(raw)) == 16+count*8 {
		offset = 16
	} else if uint64(len(raw)) != 8+count*8 {
		fmt.Fprintln(os.Stderr, "input size does not match either .bin header format")
		os.Exit(1)
	}

	values := make([]int64, count)
	for i := range values {
		values[i] = int64(binary.LittleEndian.Uint64(raw[offset+uint64(i)*8:]))
	}

	compressed := make([]byte, 0, len(values)*5+16)
	started := time.Now()
	var previous int64
	for _, value := range values {
		delta := value
		if opts.Mode != "raw" {
			delta = value - previous
		}
		previous = value
		compressed = writeVarint(compressed, zigzagEncode(delta))
	}
	compressedAt := time.Now()

	if verify {
		index := 0
		previous = 0
		for i, want := range values {
			delta := zigzagDecode(readVarint(compressed, &index))
			value := delta
			if opts.Mode != "raw" {
				value = previous + delta
			}
			if value != want {
				fmt.Fprintf(os.Stderr, "round-trip verification failed at %d\n", i)
				os.Exit(1)
			}
			previous = value
		}
	}
	verifiedAt := time.Now()

	originalSize := int64(len(values)) * 8
	uncompressedBits := int64(len(values)) * 64
	compressedBits := int64(len(compressed)) * 8
	ratio := 0.0
	if uncompressedBits > 0 {
		ratio = float64(compressedBits) / float64(uncompressedBits)
	}
	compressMbs := 0.0
	if d := compressedAt.Sub(started).Seconds(); d > 0 {
		compressMbs = (float64(originalSize) / 1048576) / d
	}
	decompressMbs := 0.0
	if d := verifiedAt.Sub(compressedAt).Seconds(); d > 0 {
		decompressMbs = (float64(originalSize) / 1048576) / d
	}

	file, err := os.Create(outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot write output %s: %v\n", outPath, err)
		os.Exit(1)
	}
	defer file.Close()

	fmt.Fprintln(file, csvHeader)
	fmt.Fprintf(file, "%s,example,%d,%d,,%d,%d,%.6f,%.3f,%.3f,,\n",
		name, len(values), originalSize, uncompressedBits, compressedBits,
		ratio, compressMbs, decompressMbs)
}
