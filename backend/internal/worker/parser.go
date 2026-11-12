package worker

import (
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"sort"
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

// Aggregation methods for combining the rows of one compressor over all
// inputs (files, CSV columns, archive members or dataset chunks).
const (
	// AggregateMean is the arithmetic mean of every metric (default).
	AggregateMean = "mean"
	// AggregateMedian is the per-metric median (robust to outlier chunks).
	AggregateMedian = "median"
	// AggregatePooled treats all inputs as one dataset: sizes are summed, the
	// ratio is Σcompressed/Σuncompressed, compression/decompression
	// throughput is total values over total time (value-weighted harmonic
	// mean), random-access and range-query throughputs are harmonic means
	// (every input runs the same number of queries), latencies and memory
	// metrics are arithmetic means.
	AggregatePooled = "pooled"
)

// ValidAggregation reports whether method is a supported aggregation.
func ValidAggregation(method string) bool {
	switch method {
	case AggregateMean, AggregateMedian, AggregatePooled:
		return true
	}
	return false
}

// AverageRows aggregates rows with the arithmetic mean.
func AverageRows(rows []BenchmarkRow) []BenchmarkRow {
	return AggregateRows(rows, AggregateMean)
}

// AggregateRows combines all rows of each compressor into one row. Every
// optional metric is aggregated over the rows that reported it, and a metric
// missing from every row stays missing (stored as NULL). Unknown methods fall
// back to the mean.
func AggregateRows(rows []BenchmarkRow, method string) []BenchmarkRow {
	if !ValidAggregation(method) {
		method = AggregateMean
	}
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
		result = append(result, aggregateGroup(comp, groups[comp], method))
	}
	return result
}

// sample is one reported value with the input's value count (pooled weights).
type sample struct {
	value  float64
	weight float64
}

// reducer combines the samples of one metric.
type reducer func([]sample) float64

func reduceMean(s []sample) float64 {
	sum := 0.0
	for _, x := range s {
		sum += x.value
	}
	return sum / float64(len(s))
}

func reduceMedian(s []sample) float64 {
	values := make([]float64, len(s))
	for i, x := range s {
		values[i] = x.value
	}
	sort.Float64s(values)
	mid := len(values) / 2
	if len(values)%2 == 1 {
		return values[mid]
	}
	return (values[mid-1] + values[mid]) / 2
}

func reduceSum(s []sample) float64 {
	sum := 0.0
	for _, x := range s {
		sum += x.value
	}
	return sum
}

// reduceHarmonic is the weighted harmonic mean Σw / Σ(w/v): total work over
// total time when v is a throughput and w the work done. Zero throughputs
// (no measurable work) are skipped.
func reduceHarmonic(s []sample) float64 {
	var work, time float64
	for _, x := range s {
		if x.value <= 0 || x.weight <= 0 {
			continue
		}
		work += x.weight
		time += x.weight / x.value
	}
	if time == 0 {
		return reduceMean(s)
	}
	return work / time
}

func aggregateGroup(comp string, group []BenchmarkRow, method string) BenchmarkRow {
	out := BenchmarkRow{
		Compressor:   comp,
		Dataset:      group[0].Dataset,
		RangeQueries: make(map[string]float64),
		Missing:      make(map[string]bool),
	}

	// pick returns the reducer for a metric class under the chosen method.
	pick := func(pooled reducer) reducer {
		switch method {
		case AggregateMedian:
			return reduceMedian
		case AggregatePooled:
			return pooled
		}
		return reduceMean
	}
	equalWork := func(s []sample) float64 { // same query count per input
		unit := make([]sample, len(s))
		for i, x := range s {
			unit[i] = sample{value: x.value, weight: 1}
		}
		return reduceHarmonic(unit)
	}

	type metric struct {
		key    string // "" = mandatory column, always reported
		get    func(*BenchmarkRow) float64
		set    func(*BenchmarkRow, float64)
		reduce reducer
	}
	setInt := func(dst *int64) func(*BenchmarkRow, float64) {
		return func(_ *BenchmarkRow, v float64) { *dst = int64(math.Round(v)) }
	}
	metrics := []metric{
		{"", func(r *BenchmarkRow) float64 { return float64(r.NumValues) }, setInt(&out.NumValues), pick(reduceSum)},
		{"", func(r *BenchmarkRow) float64 { return float64(r.OriginalSize) }, setInt(&out.OriginalSize), pick(reduceSum)},
		{"", func(r *BenchmarkRow) float64 { return float64(r.UncompressedBits) }, setInt(&out.UncompressedBits), pick(reduceSum)},
		{"", func(r *BenchmarkRow) float64 { return float64(r.CompressedBits) }, setInt(&out.CompressedBits), pick(reduceSum)},
		{"memory_usage", func(r *BenchmarkRow) float64 { return float64(r.MemoryUsage) }, setInt(&out.MemoryUsage), pick(reduceMean)},
		{"input_buffer", func(r *BenchmarkRow) float64 { return float64(r.InputBuffer) }, setInt(&out.InputBuffer), pick(reduceMean)},
		{"compressor_internal", func(r *BenchmarkRow) float64 { return float64(r.CompressorInternal) }, setInt(&out.CompressorInternal), pick(reduceMean)},
		{"", func(r *BenchmarkRow) float64 { return r.CompressionRatio }, func(_ *BenchmarkRow, v float64) { out.CompressionRatio = v }, pick(reduceMean)},
		{"compression_throughput_mbs", func(r *BenchmarkRow) float64 { return r.CompressionThroughputMbs }, func(_ *BenchmarkRow, v float64) { out.CompressionThroughputMbs = v }, pick(reduceHarmonic)},
		{"decompression_throughput_mbs", func(r *BenchmarkRow) float64 { return r.DecompressionThroughputMbs }, func(_ *BenchmarkRow, v float64) { out.DecompressionThroughputMbs = v }, pick(reduceHarmonic)},
		{"random_access_ns", func(r *BenchmarkRow) float64 { return r.RandomAccessNs }, func(_ *BenchmarkRow, v float64) { out.RandomAccessNs = v }, pick(reduceMean)},
		{"random_access_mbs", func(r *BenchmarkRow) float64 { return r.RandomAccessMbs }, func(_ *BenchmarkRow, v float64) { out.RandomAccessMbs = v }, pick(equalWork)},
		{"internal_memory_ratio", func(r *BenchmarkRow) float64 { return r.InternalMemoryRatio }, func(_ *BenchmarkRow, v float64) { out.InternalMemoryRatio = v }, pick(reduceMean)},
		{"relative_memory_usage", func(r *BenchmarkRow) float64 { return r.RelativeMemoryUsage }, func(_ *BenchmarkRow, v float64) { out.RelativeMemoryUsage = v }, pick(reduceMean)},
	}

	for _, m := range metrics {
		samples := make([]sample, 0, len(group))
		for i := range group {
			if m.key == "" || !group[i].Missing[m.key] {
				samples = append(samples, sample{value: m.get(&group[i]), weight: float64(group[i].NumValues)})
			}
		}
		if len(samples) == 0 {
			out.Missing[m.key] = true
			continue
		}
		m.set(&out, m.reduce(samples))
	}

	// Pooled ratio: total compressed over total uncompressed bits.
	if method == AggregatePooled && out.UncompressedBits > 0 {
		out.CompressionRatio = float64(out.CompressedBits) / float64(out.UncompressedBits)
	}

	// Each range size is aggregated over the rows that measured it.
	ranges := make(map[string][]sample)
	for i := range group {
		for k, v := range group[i].RangeQueries {
			ranges[k] = append(ranges[k], sample{value: v, weight: 1})
		}
	}
	reduceRange := pick(equalWork)
	for k, s := range ranges {
		out.RangeQueries[k] = reduceRange(s)
	}
	return out
}
