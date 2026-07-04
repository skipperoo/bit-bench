package compressor

import (
	"encoding/json"
	"testing"
)

func TestRegistryHasAllExpectedCompressors(t *testing.T) {
	expected := []string{
		"gorilla", "chimp", "chimp128", "tsxor", "elf", "alp",
		"neats", "camel", "falcon",
		"pfordelta",
		"gzip_1", "gzip_6", "gzip_9",
		"dac", "rle_gef",
		"u_gef_approximate", "u_gef_optimal",
		"b_gef_approximate", "b_gef_optimal",
		"b_star_gef_approximate", "b_star_gef_optimal",
		"bzip3",
		"bzip2", "lz4", "zstd", "brotli", "xz", "snappy",
	}

	for _, name := range expected {
		if _, ok := Registry[name]; !ok {
			t.Errorf("missing compressor: %s", name)
		}
	}
}

func TestNeatsOptions(t *testing.T) {
	opts := Registry["neats"]

	if opt, ok := opts["max_bpc"]; !ok {
		t.Error("neats missing max_bpc")
	} else {
		assertOption(t, "neats.max_bpc", opt, "number", 0, 64, 32, 1)
	}

	if opt, ok := opts["lossy"]; !ok {
		t.Error("neats missing lossy")
	} else if opt.Type != "boolean" || opt.Default != false {
		t.Error("neats.lossy should be boolean with default false")
	}
}

func TestCamelOptions(t *testing.T) {
	opts := Registry["camel"]
	opt, ok := opts["max_precision"]
	if !ok {
		t.Fatal("camel missing max_precision")
	}
	assertOption(t, "camel.max_precision", opt, "number", 0, 18, 18, 1)
}

func TestFalconOptions(t *testing.T) {
	opts := Registry["falcon"]
	opt, ok := opts["decimals"]
	if !ok {
		t.Fatal("falcon missing decimals")
	}
	assertOption(t, "falcon.decimals", opt, "number", -1, 18, -1, 1)
}

func TestPForDeltaOptions(t *testing.T) {
	opts := Registry["pfordelta"]
	opt, ok := opts["codec"]
	if !ok {
		t.Fatal("pfordelta missing codec")
	}
	if opt.Type != "select" {
		t.Errorf("pfordelta.codec type should be 'select', got %q", opt.Type)
	}
	if len(opt.Options) < 5 {
		t.Errorf("pfordelta.codec should have at least 5 options, got %d", len(opt.Options))
	}
	if opt.Default != "simdnewpfor" {
		t.Errorf("pfordelta.codec default should be 'simdnewpfor', got %v", opt.Default)
	}
}

func TestGZipHasNoOptions(t *testing.T) {
	for _, name := range []string{"gzip_1", "gzip_6", "gzip_9"} {
		if len(Registry[name]) != 0 {
			t.Errorf("%s should have no options (level is encoded in name)", name)
		}
	}
}

func TestEmptyCompressorsHaveNoOptions(t *testing.T) {
	emptyOnes := []string{
		"gorilla", "chimp", "chimp128", "tsxor", "elf", "alp",
		"dac", "rle_gef",
		"u_gef_approximate", "u_gef_optimal",
		"b_gef_approximate", "b_gef_optimal",
		"b_star_gef_approximate", "b_star_gef_optimal",
		"bzip3",
		"bzip2", "lz4", "zstd", "brotli", "xz", "snappy",
	}
	for _, name := range emptyOnes {
		if len(Registry[name]) != 0 {
			t.Errorf("%s should have empty options, got %d", name, len(Registry[name]))
		}
	}
}

func TestRegistrySerialization(t *testing.T) {
	data, err := json.Marshal(Registry)
	if err != nil {
		t.Fatalf("failed to marshal registry: %v", err)
	}

	var decoded map[string]map[string]Option
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal registry: %v", err)
	}

	if len(decoded) != len(Registry) {
		t.Errorf("serialization round-trip changed compressor count: %d → %d", len(Registry), len(decoded))
	}

	for name, opts := range Registry {
		decodedOpts, ok := decoded[name]
		if !ok {
			t.Errorf("compressor %s missing after round-trip", name)
			continue
		}
		if len(opts) != len(decodedOpts) {
			t.Errorf("compressor %s option count mismatch: %d → %d", name, len(opts), len(decodedOpts))
		}
	}
}

func assertOption(t *testing.T, path string, opt Option, expectedType string, expectedMin, expectedMax int, expectedDefault any, expectedStep int) {
	t.Helper()
	if opt.Type != expectedType {
		t.Errorf("%s type = %q, want %q", path, opt.Type, expectedType)
	}
	if opt.Min == nil || *opt.Min != expectedMin {
		t.Errorf("%s min = %v, want %d", path, opt.Min, expectedMin)
	}
	if opt.Max == nil || *opt.Max != expectedMax {
		t.Errorf("%s max = %v, want %d", path, opt.Max, expectedMax)
	}
	if opt.Default != expectedDefault {
		t.Errorf("%s default = %v, want %v", path, opt.Default, expectedDefault)
	}
	if opt.Step == nil || *opt.Step != expectedStep {
		t.Errorf("%s step = %v, want %d", path, opt.Step, expectedStep)
	}
}
