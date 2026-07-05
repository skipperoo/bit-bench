package worker

import (
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

func TestBuildCompressorList(t *testing.T) {
	compressors := map[string]interface{}{
		"gzip":   map[string]interface{}{"level": float64(6)},
		"neats":  map[string]interface{}{"max_bpc": float64(32), "lossy": false},
	}
	list := BuildCompressorList(compressors)
	if !strings.Contains(list, "gzip") || !strings.Contains(list, "neats") {
		t.Errorf("compressor list = %q, should contain gzip and neats", list)
	}
}

func TestBuildCompressorListLevel(t *testing.T) {
	compressors := map[string]interface{}{
		"gzip":   map[string]interface{}{"level": float64(3)},
	}
	list := BuildCompressorList(compressors)
	if list != "gzip=3" {
		t.Errorf("gzip with level=3 should map to gzip=3, got %q", list)
	}
}

func TestBuildCompressorListPForDelta(t *testing.T) {
	compressors := map[string]interface{}{
		"pfordelta": map[string]interface{}{"codec": "simdpfor"},
	}
	list := BuildCompressorList(compressors)
	if list != "pfordelta_simdpfor" {
		t.Errorf("pfordelta with codec=simdpfor should map to pfordelta_simdpfor, got %q", list)
	}
}

func TestBuildCompressorListPForDeltaDefault(t *testing.T) {
	compressors := map[string]interface{}{
		"pfordelta": map[string]interface{}{"codec": "simdnewpfor"},
	}
	list := BuildCompressorList(compressors)
	if list != "pfordelta" {
		t.Errorf("pfordelta with default codec should stay as pfordelta, got %q", list)
	}
}
