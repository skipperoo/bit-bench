package worker

import (
	"testing"

	"github.com/google/uuid"
)

func TestAverageRowsMemoryFields(t *testing.T) {
	rows := []BenchmarkRow{
		{Compressor: "gzip", MemoryUsage: 100, InputBuffer: 10, CompressorInternal: 20, InternalMemoryRatio: 2, RelativeMemoryUsage: 10},
		{Compressor: "gzip", MemoryUsage: 300, InputBuffer: 30, CompressorInternal: 60, InternalMemoryRatio: 4, RelativeMemoryUsage: 20},
	}

	avg := AverageRows(rows)[0]
	if avg.MemoryUsage != 200 {
		t.Errorf("memory_usage = %d, want 200", avg.MemoryUsage)
	}
	if avg.InputBuffer != 20 {
		t.Errorf("input_buffer = %d, want 20", avg.InputBuffer)
	}
	if avg.CompressorInternal != 40 {
		t.Errorf("compressor_internal = %d, want 40", avg.CompressorInternal)
	}
	if avg.InternalMemoryRatio != 3 {
		t.Errorf("internal_memory_ratio = %v, want 3", avg.InternalMemoryRatio)
	}
	if avg.RelativeMemoryUsage != 15 {
		t.Errorf("relative_memory_usage = %v, want 15", avg.RelativeMemoryUsage)
	}
}

func TestAverageRowsPartialMemory(t *testing.T) {
	rows := []BenchmarkRow{
		{Compressor: "custom", MemoryUsage: 100, InputBuffer: 10},
		{Compressor: "custom", Missing: map[string]bool{"memory_usage": true, "input_buffer": true}},
	}

	avg := AverageRows(rows)[0]
	if avg.MemoryUsage != 100 || avg.InputBuffer != 10 {
		t.Errorf("partial average = (%d, %d), want (100, 10)", avg.MemoryUsage, avg.InputBuffer)
	}
	if avg.Missing["memory_usage"] || avg.Missing["input_buffer"] {
		t.Errorf("reported metrics should not be marked missing: %v", avg.Missing)
	}
}

func TestRowToResultMissingMetrics(t *testing.T) {
	row := BenchmarkRow{
		Compressor: "custom",
		Missing: map[string]bool{
			"memory_usage": true, "input_buffer": true, "compressor_internal": true,
			"internal_memory_ratio": true, "relative_memory_usage": true,
			"random_access_ns": true, "random_access_mbs": true,
		},
	}

	res := rowToResult(uuid.New(), "ds", row)
	if res.MemoryUsage != nil || res.InputBuffer != nil || res.CompressorInternal != nil {
		t.Error("memory fields should be NULL when missing")
	}
	if res.InternalMemoryRatio != nil || res.RelativeMemoryUsage != nil {
		t.Error("memory ratios should be NULL when missing")
	}
	if res.RandomAccessNs != nil || res.RandomAccessMbs != nil {
		t.Error("random access fields should be NULL when missing")
	}
	if res.CompressionRatio == nil {
		t.Error("compression_ratio should always be stored")
	}
}
