package worker

import (
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// rangeColumnLabel extracts the range size from a range-query column. The
// native harness emits "range_<N>_mbs"; "range_query_<N>" is the documented
// alias accepted from user packages.
func rangeColumnLabel(col string) (string, bool) {
	switch {
	case strings.HasPrefix(col, "range_query_"):
		return strings.TrimPrefix(col, "range_query_"), true
	case strings.HasPrefix(col, "range_query "):
		return strings.TrimPrefix(col, "range_query "), true
	case strings.HasPrefix(col, "range_") && strings.HasSuffix(col, "_mbs") && len(col) > len("range__mbs"):
		return strings.TrimSuffix(strings.TrimPrefix(col, "range_"), "_mbs"), true
	}
	return "", false
}

// optionalFloat parses an optional metric cell. Empty (lenient only) and
// non-finite values (a zero-duration timer yields +Inf) are reported as
// missing so they are stored as NULL instead of breaking JSON encoding.
func optionalFloat(record []string, colIndex map[string]int, col string, lenient bool) (float64, bool, error) {
	if lenient && cellEmpty(record, colIndex, col) {
		return 0, false, nil
	}
	v, err := parseFloat(record, colIndex, col)
	if err != nil {
		return 0, false, err
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false, nil
	}
	return v, true, nil
}

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
	RandomAccessNs             float64
	RandomAccessMbs            float64
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
	rangeCols := make(map[int]string)
	for i, col := range header {
		col = strings.TrimSpace(col)
		colIndex[col] = i
		if label, ok := rangeColumnLabel(col); ok {
			rangeCols[i] = label
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
			Compressor:   strings.TrimSpace(record[colIndex["compressor"]]),
			Dataset:      record[colIndex["dataset"]],
			RangeQueries: make(map[string]float64),
			Missing:      make(map[string]bool),
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
		if math.IsNaN(row.CompressionRatio) || math.IsInf(row.CompressionRatio, 0) {
			return nil, fmt.Errorf("line %d: compression_ratio is not finite", lineNum)
		}
		for _, metric := range []struct {
			col string
			dst *float64
		}{
			{"compression_throughput_mbs", &row.CompressionThroughputMbs},
			{"decompression_throughput_mbs", &row.DecompressionThroughputMbs},
			{"random_access_ns", &row.RandomAccessNs},
			{"random_access_mbs", &row.RandomAccessMbs},
		} {
			// Throughputs are mandatory cells even in lenient mode.
			allowEmpty := lenient && (metric.col == "random_access_ns" || metric.col == "random_access_mbs")
			v, ok, err := optionalFloat(record, colIndex, metric.col, allowEmpty)
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", lineNum, err)
			}
			if ok {
				*metric.dst = v
			} else {
				row.Missing[metric.col] = true
			}
		}

		// Range-query throughputs. The harness prints 0.0 for range sizes that
		// do not fit in the sequence (range >= num_values); those are not
		// measurements and are skipped, like unparseable or non-finite cells.
		for idx, label := range rangeCols {
			if idx >= len(record) {
				continue
			}
			val, err := strconv.ParseFloat(strings.TrimSpace(record[idx]), 64)
			if err != nil || math.IsNaN(val) || math.IsInf(val, 0) {
				continue
			}
			if size, err := strconv.ParseInt(label, 10, 64); err == nil && size >= row.NumValues && val == 0 {
				continue
			}
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
// Every optional metric is averaged over the rows that reported it, and a
// metric missing from every row stays missing (stored as NULL).
func AverageRows(rows []BenchmarkRow) []BenchmarkRow {
	order := make([]string, 0)
	groups := make(map[string][]BenchmarkRow)
	for _, r := range rows {
		if _, ok := groups[r.Compressor]; !ok {
			order = append(order, r.Compressor)
		}
		groups[r.Compressor] = append(groups[r.Compressor], r)
	}

	result := make([]BenchmarkRow, 0, len(order))
	for _, comp := range order {
		result = append(result, averageGroup(comp, groups[comp]))
	}
	return result
}

// metricAccumulator collects the reported values of one metric.
type metricAccumulator struct {
	sum   float64
	count int
}

func (a *metricAccumulator) add(v float64) { a.sum += v; a.count++ }

// mean returns the average and whether any row reported the metric.
func (a *metricAccumulator) mean() (float64, bool) {
	if a.count == 0 {
		return 0, false
	}
	return a.sum / float64(a.count), true
}

func averageGroup(comp string, group []BenchmarkRow) BenchmarkRow {
	avg := BenchmarkRow{
		Compressor:   comp,
		Dataset:      group[0].Dataset,
		RangeQueries: make(map[string]float64),
		Missing:      make(map[string]bool),
	}

	type intMetric struct {
		key string
		get func(*BenchmarkRow) int64
		set func(*BenchmarkRow, int64)
	}
	type floatMetric struct {
		key string
		get func(*BenchmarkRow) float64
		set func(*BenchmarkRow, float64)
	}
	// Metrics whose key is "" are always reported (mandatory columns).
	ints := []intMetric{
		{"", func(r *BenchmarkRow) int64 { return r.NumValues }, func(r *BenchmarkRow, v int64) { r.NumValues = v }},
		{"", func(r *BenchmarkRow) int64 { return r.OriginalSize }, func(r *BenchmarkRow, v int64) { r.OriginalSize = v }},
		{"", func(r *BenchmarkRow) int64 { return r.UncompressedBits }, func(r *BenchmarkRow, v int64) { r.UncompressedBits = v }},
		{"", func(r *BenchmarkRow) int64 { return r.CompressedBits }, func(r *BenchmarkRow, v int64) { r.CompressedBits = v }},
		{"memory_usage", func(r *BenchmarkRow) int64 { return r.MemoryUsage }, func(r *BenchmarkRow, v int64) { r.MemoryUsage = v }},
		{"input_buffer", func(r *BenchmarkRow) int64 { return r.InputBuffer }, func(r *BenchmarkRow, v int64) { r.InputBuffer = v }},
		{"compressor_internal", func(r *BenchmarkRow) int64 { return r.CompressorInternal }, func(r *BenchmarkRow, v int64) { r.CompressorInternal = v }},
	}
	floats := []floatMetric{
		{"", func(r *BenchmarkRow) float64 { return r.CompressionRatio }, func(r *BenchmarkRow, v float64) { r.CompressionRatio = v }},
		{"compression_throughput_mbs", func(r *BenchmarkRow) float64 { return r.CompressionThroughputMbs }, func(r *BenchmarkRow, v float64) { r.CompressionThroughputMbs = v }},
		{"decompression_throughput_mbs", func(r *BenchmarkRow) float64 { return r.DecompressionThroughputMbs }, func(r *BenchmarkRow, v float64) { r.DecompressionThroughputMbs = v }},
		{"random_access_ns", func(r *BenchmarkRow) float64 { return r.RandomAccessNs }, func(r *BenchmarkRow, v float64) { r.RandomAccessNs = v }},
		{"random_access_mbs", func(r *BenchmarkRow) float64 { return r.RandomAccessMbs }, func(r *BenchmarkRow, v float64) { r.RandomAccessMbs = v }},
		{"internal_memory_ratio", func(r *BenchmarkRow) float64 { return r.InternalMemoryRatio }, func(r *BenchmarkRow, v float64) { r.InternalMemoryRatio = v }},
		{"relative_memory_usage", func(r *BenchmarkRow) float64 { return r.RelativeMemoryUsage }, func(r *BenchmarkRow, v float64) { r.RelativeMemoryUsage = v }},
	}

	for _, m := range ints {
		var acc metricAccumulator
		for i := range group {
			if m.key == "" || !group[i].Missing[m.key] {
				acc.add(float64(m.get(&group[i])))
			}
		}
		if v, ok := acc.mean(); ok {
			m.set(&avg, int64(math.Round(v)))
		} else {
			avg.Missing[m.key] = true
		}
	}
	for _, m := range floats {
		var acc metricAccumulator
		for i := range group {
			if m.key == "" || !group[i].Missing[m.key] {
				acc.add(m.get(&group[i]))
			}
		}
		if v, ok := acc.mean(); ok {
			m.set(&avg, v)
		} else {
			avg.Missing[m.key] = true
		}
	}

	// Each range size is averaged over the rows that measured it.
	ranges := make(map[string]*metricAccumulator)
	for i := range group {
		for k, v := range group[i].RangeQueries {
			if ranges[k] == nil {
				ranges[k] = &metricAccumulator{}
			}
			ranges[k].add(v)
		}
	}
	for k, acc := range ranges {
		if v, ok := acc.mean(); ok {
			avg.RangeQueries[k] = v
		}
	}
	return avg
}
