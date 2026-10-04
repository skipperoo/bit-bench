package worker

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type BenchmarkRow struct {
	Compressor                 string
	Dataset                    string
	NumValues                  int64
	OriginalSize               int64
	MemoryUsage                int64
	UncompressedBits           int64
	CompressedBits             int64
	CompressionRatio           float64
	CompressionThroughputMbs   float64
	DecompressionThroughputMbs float64
	RandomAccessNs           float64
	RandomAccessMbs          float64
	// Memory metrics measured by the native harness (built-in tasks only).
	InputBuffer         int64
	CompressorInternal  int64
	InternalMemoryRatio float64
	RelativeMemoryUsage float64
	RangeQueries        map[string]float64
	// Missing marks optional metrics whose cells were empty (not reported).
	// Only populated by ParseCSVLenient and by tasks without memory results.
	Missing map[string]bool
}

func ParseCSV(r io.Reader) ([]BenchmarkRow, error) {
	return parseCSV(r, false)
}

// ParseCSVLenient allows the optional metric cells to be empty, marking them
// as missing. Used for user-provided compressor output.
func ParseCSVLenient(r io.Reader) ([]BenchmarkRow, error) {
	return parseCSV(r, true)
}

func parseCSV(r io.Reader, lenient bool) ([]BenchmarkRow, error) {
	reader := csv.NewReader(r)
	reader.TrimLeadingSpace = true

	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	colIndex := make(map[string]int)
	rangeCols := make([]int, 0)
	for i, col := range header {
		col = strings.TrimSpace(col)
		colIndex[col] = i
		if strings.HasPrefix(col, "range_query_") || strings.HasPrefix(col, "range_query ") {
			rangeCols = append(rangeCols, i)
		}
	}

	required := []string{"compressor", "dataset", "num_values", "original_size",
		"memory_usage", "uncompressed_bits", "compressed_bits",
		"compression_ratio", "compression_throughput_mbs",
		"decompression_throughput_mbs", "random_access_ns", "random_access_mbs"}
	for _, col := range required {
		if _, ok := colIndex[col]; !ok {
			return nil, fmt.Errorf("missing required column: %s", col)
		}
	}

	var rows []BenchmarkRow
	lineNum := 1
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row %d: %w", lineNum, err)
		}
		lineNum++

		row := BenchmarkRow{
			Compressor:   record[colIndex["compressor"]],
			Dataset:      record[colIndex["dataset"]],
			RangeQueries: make(map[string]float64),
		}
		if lenient {
			row.Missing = make(map[string]bool)
		}

		if row.NumValues, err = parseInt(record, colIndex, "num_values"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.OriginalSize, err = parseInt(record, colIndex, "original_size"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if lenient && cellEmpty(record, colIndex, "memory_usage") {
			row.Missing["memory_usage"] = true
		} else if row.MemoryUsage, err = parseInt(record, colIndex, "memory_usage"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.UncompressedBits, err = parseInt(record, colIndex, "uncompressed_bits"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.CompressedBits, err = parseInt(record, colIndex, "compressed_bits"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.CompressionRatio, err = parseFloat(record, colIndex, "compression_ratio"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.CompressionThroughputMbs, err = parseFloat(record, colIndex, "compression_throughput_mbs"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.DecompressionThroughputMbs, err = parseFloat(record, colIndex, "decompression_throughput_mbs"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if lenient && cellEmpty(record, colIndex, "random_access_ns") {
			row.Missing["random_access_ns"] = true
		} else if row.RandomAccessNs, err = parseFloat(record, colIndex, "random_access_ns"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if lenient && cellEmpty(record, colIndex, "random_access_mbs") {
			row.Missing["random_access_mbs"] = true
		} else if row.RandomAccessMbs, err = parseFloat(record, colIndex, "random_access_mbs"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}

		// Parse range query columns
		for _, idx := range rangeCols {
			colName := strings.TrimSpace(header[idx])
			val, err := strconv.ParseFloat(strings.TrimSpace(record[idx]), 64)
			if err != nil {
				continue // skip unparseable range values
			}
			// Extract the range label (e.g., "range_query_1M" -> "1M")
			label := strings.TrimPrefix(colName, "range_query_")
			label = strings.TrimPrefix(label, "range_query ")
			row.RangeQueries[label] = val
		}

		rows = append(rows, row)
	}

	return rows, nil
}

func cellEmpty(record []string, colIndex map[string]int, col string) bool {
	idx, ok := colIndex[col]
	if !ok || idx >= len(record) {
		return true
	}
	return strings.TrimSpace(record[idx]) == ""
}

func parseInt(record []string, colIndex map[string]int, col string) (int64, error) {
	idx, ok := colIndex[col]
	if !ok {
		return 0, fmt.Errorf("column %s not found", col)
	}
	return strconv.ParseInt(strings.TrimSpace(record[idx]), 10, 64)
}

func parseFloat(record []string, colIndex map[string]int, col string) (float64, error) {
	idx, ok := colIndex[col]
	if !ok {
		return 0, fmt.Errorf("column %s not found", col)
	}
	return strconv.ParseFloat(strings.TrimSpace(record[idx]), 64)
}

// AverageRows averages all rows per compressor into one row per compressor.
func AverageRows(rows []BenchmarkRow) []BenchmarkRow {
	groups := make(map[string][]BenchmarkRow)
	for _, r := range rows {
		groups[r.Compressor] = append(groups[r.Compressor], r)
	}

	var result []BenchmarkRow
	for comp, group := range groups {
		avg := BenchmarkRow{
			Compressor:   comp,
			Dataset:      group[0].Dataset,
			RangeQueries: make(map[string]float64),
			Missing:      make(map[string]bool),
		}

		var numValuesSum, originalSizeSum, memoryUsageSum int64
		var uncompressedSum, compressedSum int64
		var ratioSum, tpSum, decompSum, ransSum, rambsSum float64
		var inputBufferSum, compressorInternalSum int64
		var internalRatioSum, relativeMemorySum float64
		n := len(group)
		memoryCount, ransCount, rambsCount := 0, 0, 0
		inputBufferCount, compressorInternalCount := 0, 0
		internalRatioCount, relativeMemoryCount := 0, 0

		for _, r := range group {
			numValuesSum += r.NumValues
			originalSizeSum += r.OriginalSize
			if !r.Missing["memory_usage"] {
				memoryUsageSum += r.MemoryUsage
				memoryCount++
			}
			if !r.Missing["input_buffer"] {
				inputBufferSum += r.InputBuffer
				inputBufferCount++
			}
			if !r.Missing["compressor_internal"] {
				compressorInternalSum += r.CompressorInternal
				compressorInternalCount++
			}
			if !r.Missing["internal_memory_ratio"] {
				internalRatioSum += r.InternalMemoryRatio
				internalRatioCount++
			}
			if !r.Missing["relative_memory_usage"] {
				relativeMemorySum += r.RelativeMemoryUsage
				relativeMemoryCount++
			}
			uncompressedSum += r.UncompressedBits
			compressedSum += r.CompressedBits
			ratioSum += r.CompressionRatio
			tpSum += r.CompressionThroughputMbs
			decompSum += r.DecompressionThroughputMbs
			if !r.Missing["random_access_ns"] {
				ransSum += r.RandomAccessNs
				ransCount++
			}
			if !r.Missing["random_access_mbs"] {
				rambsSum += r.RandomAccessMbs
				rambsCount++
			}

			for k, v := range r.RangeQueries {
				avg.RangeQueries[k] += v
			}
		}

		avg.NumValues = numValuesSum / int64(n)
		avg.OriginalSize = originalSizeSum / int64(n)
		avg.UncompressedBits = uncompressedSum / int64(n)
		avg.CompressedBits = compressedSum / int64(n)
		avg.CompressionRatio = ratioSum / float64(n)
		avg.CompressionThroughputMbs = tpSum / float64(n)
		avg.DecompressionThroughputMbs = decompSum / float64(n)

		if memoryCount > 0 {
			avg.MemoryUsage = memoryUsageSum / int64(memoryCount)
		} else {
			avg.Missing["memory_usage"] = true
		}
		if inputBufferCount > 0 {
			avg.InputBuffer = inputBufferSum / int64(inputBufferCount)
		} else {
			avg.Missing["input_buffer"] = true
		}
		if compressorInternalCount > 0 {
			avg.CompressorInternal = compressorInternalSum / int64(compressorInternalCount)
		} else {
			avg.Missing["compressor_internal"] = true
		}
		if internalRatioCount > 0 {
			avg.InternalMemoryRatio = internalRatioSum / float64(internalRatioCount)
		} else {
			avg.Missing["internal_memory_ratio"] = true
		}
		if relativeMemoryCount > 0 {
			avg.RelativeMemoryUsage = relativeMemorySum / float64(relativeMemoryCount)
		} else {
			avg.Missing["relative_memory_usage"] = true
		}
		if ransCount > 0 {
			avg.RandomAccessNs = ransSum / float64(ransCount)
		} else {
			avg.Missing["random_access_ns"] = true
		}
		if rambsCount > 0 {
			avg.RandomAccessMbs = rambsSum / float64(rambsCount)
		} else {
			avg.Missing["random_access_mbs"] = true
		}

		for k := range avg.RangeQueries {
			avg.RangeQueries[k] /= float64(n)
		}

		result = append(result, avg)
	}

	return result
}
