package worker

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type BenchmarkRow struct {
	Compressor               string
	Dataset                  string
	NumValues                int64
	OriginalSize             int64
	MemoryUsage              int64
	UncompressedBits         int64
	CompressedBits           int64
	CompressionRatio         float64
	CompressionThroughputMbs float64
	DecompressionThroughputMbs float64
	RandomAccessNs           float64
	RandomAccessMbs          float64
	RangeQueries             map[string]float64
}

func ParseCSV(r io.Reader) ([]BenchmarkRow, error) {
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
			Compressor: record[colIndex["compressor"]],
			Dataset:    record[colIndex["dataset"]],
			RangeQueries: make(map[string]float64),
		}

		if row.NumValues, err = parseInt(record, colIndex, "num_values"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.OriginalSize, err = parseInt(record, colIndex, "original_size"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.MemoryUsage, err = parseInt(record, colIndex, "memory_usage"); err != nil {
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
		if row.RandomAccessNs, err = parseFloat(record, colIndex, "random_access_ns"); err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if row.RandomAccessMbs, err = parseFloat(record, colIndex, "random_access_mbs"); err != nil {
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
		}

		var numValuesSum, originalSizeSum, memoryUsageSum int64
		var uncompressedSum, compressedSum int64
		var ratioSum, tpSum, decompSum, ransSum, rambsSum float64
		n := len(group)

		for _, r := range group {
			numValuesSum += r.NumValues
			originalSizeSum += r.OriginalSize
			memoryUsageSum += r.MemoryUsage
			uncompressedSum += r.UncompressedBits
			compressedSum += r.CompressedBits
			ratioSum += r.CompressionRatio
			tpSum += r.CompressionThroughputMbs
			decompSum += r.DecompressionThroughputMbs
			ransSum += r.RandomAccessNs
			rambsSum += r.RandomAccessMbs

			for k, v := range r.RangeQueries {
				avg.RangeQueries[k] += v
			}
		}

		avg.NumValues = numValuesSum / int64(n)
		avg.OriginalSize = originalSizeSum / int64(n)
		avg.MemoryUsage = memoryUsageSum / int64(n)
		avg.UncompressedBits = uncompressedSum / int64(n)
		avg.CompressedBits = compressedSum / int64(n)
		avg.CompressionRatio = ratioSum / float64(n)
		avg.CompressionThroughputMbs = tpSum / float64(n)
		avg.DecompressionThroughputMbs = decompSum / float64(n)
		avg.RandomAccessNs = ransSum / float64(n)
		avg.RandomAccessMbs = rambsSum / float64(n)

		for k := range avg.RangeQueries {
			avg.RangeQueries[k] /= float64(n)
		}

		result = append(result, avg)
	}

	return result
}
