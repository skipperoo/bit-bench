package worker

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestDetectBinFormat16Byte(t *testing.T) {
	data := make([]byte, 16+8*10) // 10 values
	binary.LittleEndian.PutUint64(data[0:8], 10)
	binary.LittleEndian.PutUint64(data[8:16], 2) // 2 decimals

	n, dec, err := DetectBinFormat(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 10 {
		t.Errorf("n = %d, want 10", n)
	}
	if dec != 2 {
		t.Errorf("decimals = %d, want 2", dec)
	}
}

func TestDetectBinFormat8Byte(t *testing.T) {
	// 8-byte header is only unique when 16-byte doesn't match
	// Example: 8 bytes + N*8 where N=0 gives fs=8 (no values)
	data := make([]byte, 8) // 0 values, 8-byte header
	binary.LittleEndian.PutUint64(data[0:8], 0)

	n, dec, err := DetectBinFormat(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("n = %d, want 0", n)
	}
	if dec != 0 {
		t.Errorf("decimals = %d, want 0", dec)
	}
}

func TestDetectBinFormat8BytePrefers16(t *testing.T) {
	// An 8-byte file with 5 values (48 bytes) is ambiguous.
	// Both 8-byte (N=5) and 16-byte (N=4, decimals=first value) match.
	// The implementation prefers 16-byte (matching C++ behavior).
	data := make([]byte, 8+8*5)
	binary.LittleEndian.PutUint64(data[0:8], 5)
	binary.LittleEndian.PutUint64(data[8:16], 42) // first value = 42

	n, dec, err := DetectBinFormat(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 16-byte interpretation: N = (48-16)/8 = 4, decimals = first value (42)
	if n != 4 {
		t.Errorf("n = %d, want 4 (16-byte pref)", n)
	}
	if dec != 42 {
		t.Errorf("decimals = %d, want 42", dec)
	}
}

func TestDetectBinFormatInvalid(t *testing.T) {
	data := make([]byte, 10) // neither 8-byte nor 16-byte compatible
	_, _, err := DetectBinFormat(data)
	if err == nil {
		t.Error("expected error for invalid size")
	}
}

func TestReadWriteBinFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.bin")

	values := []int64{1, 2, 3, 4, 5}
	err := WriteBinFile(path, values, 0)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	info, err := ReadBinFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	if info.N != 5 {
		t.Errorf("n = %d, want 5", info.N)
	}
	for i, v := range info.Values {
		if v != values[i] {
			t.Errorf("values[%d] = %d, want %d", i, v, values[i])
		}
	}
}

func TestNormalizeBinFile(t *testing.T) {
	dir := t.TempDir()
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "data.bin")

	err := WriteBinFile(srcPath, []int64{1, 2, 3}, 0)
	if err != nil {
		t.Fatalf("write src: %v", err)
	}

	outDir := filepath.Join(dir, "out")
	paths, err := NormalizeFile(srcPath, outDir, ".bin")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(paths) != 1 {
		t.Fatalf("expected 1 path, got %d", len(paths))
	}

	_, err = os.Stat(paths[0])
	if err != nil {
		t.Errorf("output file not found: %v", err)
	}
}
