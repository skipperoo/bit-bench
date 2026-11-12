package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseCSV(t *testing.T) {
	csv := `compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs,range_query_1M,range_query_10M
gzip,test,1000,8000,100,64000,32000,0.5,500,600,100,200,1500,1200
neats,test,1000,8000,200,64000,16000,0.25,800,900,50,300,2000,1800
`

	rows, err := ParseCSV(strings.NewReader(csv))
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}

	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}

	// Check first row (gzip)
	r := rows[0]
	if r.Compressor != "gzip" {
		t.Errorf("compressor = %q, want gzip", r.Compressor)
	}
	if r.NumValues != 1000 {
		t.Errorf("num_values = %d, want 1000", r.NumValues)
	}
	if r.OriginalSize != 8000 {
		t.Errorf("original_size = %d, want 8000", r.OriginalSize)
	}
	if r.CompressionRatio != 0.5 {
		t.Errorf("compression_ratio = %f, want 0.5", r.CompressionRatio)
	}
	if r.CompressionThroughputMbs != 500 {
		t.Errorf("compression_throughput_mbs = %f, want 500", r.CompressionThroughputMbs)
	}

	// Check range queries
	if v, ok := r.RangeQueries["1M"]; !ok {
		t.Error("missing range_query_1M")
	} else if v != 1500 {
		t.Errorf("range_query_1M = %f, want 1500", v)
	}
	if v, ok := r.RangeQueries["10M"]; !ok {
		t.Error("missing range_query_10M")
	} else if v != 1200 {
		t.Errorf("range_query_10M = %f, want 1200", v)
	}
}

func TestParseCSVMissingColumn(t *testing.T) {
	csv := `compressor,dataset,num_values
gzip,test,1000
`
	_, err := ParseCSV(strings.NewReader(csv))
	if err == nil {
		t.Error("expected error for missing columns")
	}
}

func TestAverageRows(t *testing.T) {
	rows := []BenchmarkRow{
		{Compressor: "gzip", NumValues: 1000, CompressionRatio: 0.5, CompressionThroughputMbs: 500, RangeQueries: map[string]float64{"1M": 1500}},
		{Compressor: "gzip", NumValues: 2000, CompressionRatio: 0.6, CompressionThroughputMbs: 600, RangeQueries: map[string]float64{"1M": 1600}},
		{Compressor: "neats", NumValues: 1000, CompressionRatio: 0.25, CompressionThroughputMbs: 800, RangeQueries: map[string]float64{"1M": 2000}},
	}

	averaged := AverageRows(rows)
	if len(averaged) != 2 {
		t.Fatalf("expected 2 averaged rows, got %d", len(averaged))
	}

	for _, r := range averaged {
		switch r.Compressor {
		case "gzip":
			if r.NumValues != 1500 {
				t.Errorf("gzip avg num_values = %d, want 1500", r.NumValues)
			}
			if r.CompressionRatio != 0.55 {
				t.Errorf("gzip avg compression_ratio = %f, want 0.55", r.CompressionRatio)
			}
			if r.RangeQueries["1M"] != 1550 {
				t.Errorf("gzip avg range_1M = %f, want 1550", r.RangeQueries["1M"])
			}
		case "neats":
			if r.NumValues != 1000 {
				t.Errorf("neats avg num_values = %d, want 1000", r.NumValues)
			}
		}
	}
}

func TestParseCSVLenient(t *testing.T) {
	csv := `compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs
custom,test,1000,8000,,64000,32000,0.5,500,600,,
`
	if _, err := ParseCSV(strings.NewReader(csv)); err == nil {
		t.Fatal("strict parser should reject empty optional metrics")
	}

	rows, err := ParseCSVLenient(strings.NewReader(csv))
	if err != nil {
		t.Fatalf("lenient parse error: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	row := rows[0]
	if !row.Missing["memory_usage"] || !row.Missing["random_access_ns"] || !row.Missing["random_access_mbs"] {
		t.Errorf("missing flags not set: %v", row.Missing)
	}
	if row.CompressionRatio != 0.5 {
		t.Errorf("compression_ratio = %v, want 0.5", row.CompressionRatio)
	}
}

func TestAverageRowsMissingPropagation(t *testing.T) {
	rows := []BenchmarkRow{
		{Compressor: "custom", Missing: map[string]bool{"memory_usage": true, "random_access_ns": true, "random_access_mbs": true}},
		{Compressor: "custom", Missing: map[string]bool{"memory_usage": true, "random_access_ns": true, "random_access_mbs": true}},
	}
	averaged := AverageRows(rows)
	if len(averaged) != 1 {
		t.Fatalf("expected 1 row, got %d", len(averaged))
	}
	if !averaged[0].Missing["memory_usage"] {
		t.Error("memory_usage should stay missing when no row reports it")
	}

	rows = []BenchmarkRow{
		{Compressor: "custom", MemoryUsage: 100},
		{Compressor: "custom", Missing: map[string]bool{"memory_usage": true}},
	}
	averaged = AverageRows(rows)
	if averaged[0].Missing["memory_usage"] {
		t.Error("memory_usage should be reported when at least one row has it")
	}
	if averaged[0].MemoryUsage != 100 {
		t.Errorf("memory_usage average = %d, want 100", averaged[0].MemoryUsage)
	}
}

// The native harness names range columns "range_<N>_mbs" and prints 0.0 for
// range sizes that do not fit in the sequence.
func TestParseCSVHarnessRangeColumns(t *testing.T) {
	csv := `compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs,range_10_mbs,range_100_mbs,range_1000_mbs
gzip,a.bin,500,4000,0,32000,8000,0.25,100.0,200.0,50.0,10.0,12.5,0.0,0.0
`
	rows, err := ParseCSV(strings.NewReader(csv))
	if err != nil {
		t.Fatal(err)
	}
	rq := rows[0].RangeQueries
	if rq["10"] != 12.5 {
		t.Errorf("range 10 = %v, want 12.5", rq["10"])
	}
	if v, ok := rq["100"]; !ok || v != 0 {
		t.Errorf("range 100 (< num_values) must be kept, got %v (present=%v)", v, ok)
	}
	if _, ok := rq["1000"]; ok {
		t.Error("range 1000 >= num_values printed as 0.0 must be skipped")
	}
}

func TestParseCSVNonFiniteThroughputIsMissing(t *testing.T) {
	csv := `compressor,dataset,num_values,original_size,memory_usage,uncompressed_bits,compressed_bits,compression_ratio,compression_throughput_mbs,decompression_throughput_mbs,random_access_ns,random_access_mbs
gzip,a.bin,10,80,0,640,320,0.5,inf,nan,1.0,2.0
`
	rows, err := ParseCSV(strings.NewReader(csv))
	if err != nil {
		t.Fatal(err)
	}
	if !rows[0].Missing["compression_throughput_mbs"] || !rows[0].Missing["decompression_throughput_mbs"] {
		t.Fatalf("non-finite throughputs must be missing, got %+v", rows[0].Missing)
	}
	avg := AverageRows(rows)
	if _, err := json.Marshal(avg); err != nil {
		t.Fatalf("averaged rows must be JSON-encodable: %v", err)
	}
}

func TestAverageRowsRangePerKeyCount(t *testing.T) {
	rows := []BenchmarkRow{
		{Compressor: "c", RangeQueries: map[string]float64{"10": 10, "100": 100}},
		{Compressor: "c", RangeQueries: map[string]float64{"10": 30}},
	}
	avg := AverageRows(rows)
	if got := avg[0].RangeQueries["10"]; got != 20 {
		t.Errorf("range 10 = %v, want 20", got)
	}
	if got := avg[0].RangeQueries["100"]; got != 100 {
		t.Errorf("range 100 averaged over its own rows = %v, want 100", got)
	}
}
