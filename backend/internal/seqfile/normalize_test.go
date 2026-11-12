package seqfile

import (
	"archive/zip"
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
	// A simple-format file with 5 values is 48 bytes. The size alone would
	// also fit a 16-byte header with 4 values, but the native harness reads N
	// from the header: N=5 matches 8+8*5, so the file is the simple format
	// (the old size-only rule misread it as 4 values with decimals=42).
	data := make([]byte, 8+8*5)
	binary.LittleEndian.PutUint64(data[0:8], 5)
	binary.LittleEndian.PutUint64(data[8:16], 42) // first value = 42

	n, dec, err := DetectBinFormat(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 5 {
		t.Errorf("n = %d, want 5 (header-declared simple format)", n)
	}
	if dec != 0 {
		t.Errorf("decimals = %d, want 0", dec)
	}
}

func TestDetectBinFormatHeaderMismatch(t *testing.T) {
	data := make([]byte, 16+8*10)
	binary.LittleEndian.PutUint64(data[0:8], 99) // lies about N
	if _, _, err := DetectBinFormat(data); err == nil {
		t.Error("expected error when the header N does not match the file size")
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

func TestNormalizeCSVSinglePass(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "in.csv")
	// "../evil" must not escape outDir; duplicate names must not collide;
	// empty cells make columns ragged; integral floats are accepted.
	content := "../evil,a,a,empty\n1,10,100,\n2,,200,\n3.0,30,300,\n"
	if err := os.WriteFile(src, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out")
	paths, err := NormalizeFile(src, out, ".csv")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(paths) != 3 {
		t.Fatalf("got %d columns, want 3 (empty column dropped): %v", len(paths), paths)
	}
	want := map[string][]int64{"evil.bin": {1, 2, 3}, "a.bin": {10, 30}, "a_2.bin": {100, 200, 300}}
	for _, p := range paths {
		if filepath.Dir(p) != out {
			t.Fatalf("column escaped the output dir: %s", p)
		}
		info, err := ReadBinFile(p)
		if err != nil {
			t.Fatal(err)
		}
		exp, ok := want[filepath.Base(p)]
		if !ok {
			t.Fatalf("unexpected column file %s", p)
		}
		if len(info.Values) != len(exp) {
			t.Fatalf("%s: got %v, want %v", p, info.Values, exp)
		}
		for i := range exp {
			if info.Values[i] != exp[i] {
				t.Fatalf("%s: got %v, want %v", p, info.Values, exp)
			}
		}
	}
}

func TestNormalizeCSVRejectsNonInteger(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "in.csv")
	os.WriteFile(src, []byte("x\n1\n1.5\n"), 0644)
	if _, err := NormalizeFile(src, filepath.Join(dir, "out"), ".csv"); err == nil {
		t.Fatal("1.5 must be rejected instead of being truncated to 1")
	}
}

func TestNormalizeBinRejectsInvalidSize(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "bad.bin")
	data := make([]byte, 16+8*3)
	binary.LittleEndian.PutUint64(data[0:8], 7)
	os.WriteFile(src, data, 0644)
	if _, err := NormalizeFile(src, filepath.Join(dir, "out"), ".bin"); err == nil {
		t.Fatal("a .bin whose header does not match its size must be rejected")
	}
}

func binBytes(values ...int64) []byte {
	data := make([]byte, 16+8*len(values))
	binary.LittleEndian.PutUint64(data[0:8], uint64(len(values)))
	for i, v := range values {
		binary.LittleEndian.PutUint64(data[16+8*i:], uint64(v))
	}
	return data
}

func TestNormalizeZipMembers(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "in.zip")
	f, _ := os.Create(src)
	zw := zip.NewWriter(f)
	for name, data := range map[string][]byte{
		"a/x.bin":            binBytes(1, 2),
		"b/x.bin":            binBytes(3),
		"__MACOSX/a/._x.bin": []byte("junk"),
		"._y.bin":            []byte("junk"),
		"readme.txt":         []byte("hi"),
		"UPPER.BIN":          binBytes(4),
	} {
		w, _ := zw.Create(name)
		w.Write(data)
	}
	zw.Close()
	f.Close()

	paths, err := NormalizeFile(src, filepath.Join(dir, "out"), ".zip")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(paths) != 3 {
		t.Fatalf("got %v, want 3 distinct .bin members", paths)
	}

	if _, err := NormalizeFileLimit(src, filepath.Join(dir, "out2"), ".zip", 40); err == nil {
		t.Fatal("expected the extraction limit to reject the archive")
	}
}
