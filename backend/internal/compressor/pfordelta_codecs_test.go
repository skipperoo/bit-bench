package compressor

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

// TestPForDeltaCodecsMatchNativeHarness keeps the pfordelta codec options in
// sync with the makers registered in compression/benchmark/pfor_codec.hpp.
// The native harness throws "Unknown PForDelta codec" for any other value.
func TestPForDeltaCodecsMatchNativeHarness(t *testing.T) {
	path := filepath.Join("..", "..", "..", "compression", "benchmark", "pfor_codec.hpp")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	re := regexp.MustCompile(`\{"([a-z0-9_]+)",\s*FastPForLib::`)
	matches := re.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		t.Fatalf("no codec makers found in %s", path)
	}
	native := make([]string, 0, len(matches))
	for _, match := range matches {
		native = append(native, match[1])
	}
	sort.Strings(native)

	option, ok := Registry["pfordelta"]["codec"]
	if !ok {
		t.Fatal("pfordelta has no codec option")
	}
	registered := append([]string(nil), option.Options...)
	sort.Strings(registered)

	if len(native) != len(registered) {
		t.Fatalf("pfordelta codecs out of sync: native=%v registry=%v", native, registered)
	}
	for i := range native {
		if native[i] != registered[i] {
			t.Errorf("pfordelta codecs out of sync: native=%v registry=%v", native, registered)
			break
		}
	}

	// The default must be a codec the harness can build.
	foundDefault := false
	for _, codec := range native {
		if codec == option.Default {
			foundDefault = true
			break
		}
	}
	if !foundDefault {
		t.Errorf("default codec %v is not supported by the native harness", option.Default)
	}
}
