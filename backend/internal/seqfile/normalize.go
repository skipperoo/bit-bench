package seqfile

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"encoding/binary"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// MaxCSVColumns bounds how many sequences one CSV upload may contain (one
// open output file per column while converting).
const MaxCSVColumns = 1024

type BinInfo struct {
	Path     string
	N        uint64
	Decimals uint64
	Values   []int64
}

// BinHeader describes a validated .bin file.
type BinHeader struct {
	N          uint64
	Decimals   uint64
	HeaderSize int64 // 16 (standard) or 8 (simple)
}

// DetectBinHeader interprets a .bin header exactly like the native harness:
// N is the first little-endian uint64; the file is "standard" when its size is
// 16+8N (the second word is the decimals count) and "simple" when it is 8+8N.
// head must hold the first min(16, size) bytes of the file.
func DetectBinHeader(size int64, head []byte) (BinHeader, error) {
	if size < 8 || len(head) < 8 {
		return BinHeader{}, fmt.Errorf("invalid .bin file: %d bytes is shorter than the 8-byte header", size)
	}
	n := binary.LittleEndian.Uint64(head[0:8])
	if n > uint64(math.MaxInt64-16)/8 {
		return BinHeader{}, fmt.Errorf("invalid .bin file: header declares %d values", n)
	}
	payload := int64(n) * 8
	switch size {
	case 16 + payload:
		if len(head) < 16 {
			return BinHeader{}, fmt.Errorf("invalid .bin file: truncated header")
		}
		return BinHeader{N: n, Decimals: binary.LittleEndian.Uint64(head[8:16]), HeaderSize: 16}, nil
	case 8 + payload:
		return BinHeader{N: n, HeaderSize: 8}, nil
	}
	return BinHeader{}, fmt.Errorf(
		"invalid .bin file: header declares %d values, which needs %d (standard) or %d (simple) bytes, but the file has %d",
		n, 16+payload, 8+payload, size)
}

// DetectBinFormat returns the value count and decimals of an in-memory .bin.
func DetectBinFormat(data []byte) (n uint64, decimals uint64, err error) {
	h, err := DetectBinHeader(int64(len(data)), data[:min(16, len(data))])
	if err != nil {
		return 0, 0, err
	}
	return h.N, h.Decimals, nil
}

// ValidateBinFile checks that a .bin file has a consistent header and at
// least one value (the native harness cannot benchmark empty sequences).
func ValidateBinFile(p string) (BinHeader, error) {
	f, err := os.Open(p)
	if err != nil {
		return BinHeader{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return BinHeader{}, err
	}
	head := make([]byte, 16)
	read, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return BinHeader{}, err
	}
	h, err := DetectBinHeader(info.Size(), head[:read])
	if err != nil {
		return BinHeader{}, err
	}
	if h.N == 0 {
		return BinHeader{}, fmt.Errorf("invalid .bin file: it contains no values")
	}
	return h, nil
}

func ReadBinFile(p string) (*BinInfo, error) {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}

	h, err := DetectBinHeader(int64(len(data)), data[:min(16, len(data))])
	if err != nil {
		return nil, err
	}

	values := make([]int64, h.N)
	offset := int(h.HeaderSize)
	for i := range values {
		values[i] = int64(binary.LittleEndian.Uint64(data[offset+i*8:]))
	}

	return &BinInfo{
		Path:     p,
		N:        h.N,
		Decimals: h.Decimals,
		Values:   values,
	}, nil
}

// WriteBinFile writes values with the standard 16-byte header.
func WriteBinFile(p string, values []int64, decimals uint64) error {
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	if err := writeBinHeader(w, uint64(len(values)), decimals); err != nil {
		f.Close()
		return err
	}
	var buf [8]byte
	for _, v := range values {
		binary.LittleEndian.PutUint64(buf[:], uint64(v))
		if _, err := w.Write(buf[:]); err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func writeBinHeader(w io.Writer, n, decimals uint64) error {
	var header [16]byte
	binary.LittleEndian.PutUint64(header[0:8], n)
	binary.LittleEndian.PutUint64(header[8:16], decimals)
	_, err := w.Write(header[:])
	return err
}

var nonAlphaNum = regexp.MustCompile(`[^A-Za-z0-9]+`)

// SafeName turns an arbitrary label (CSV header, archive member) into a
// filesystem-safe stem: runs of non-alphanumerics become "_".
func SafeName(name, fallback string) string {
	safe := strings.Trim(nonAlphaNum.ReplaceAllString(name, "_"), "_")
	if safe == "" {
		safe = fallback
	}
	if len(safe) > 100 {
		safe = safe[:100]
	}
	return safe
}

// uniqueName returns stem, or stem_2, stem_3... when stem is already taken.
func uniqueName(stem string, taken map[string]bool) string {
	name := stem
	for i := 2; taken[strings.ToLower(name)]; i++ {
		name = fmt.Sprintf("%s_%d", stem, i)
	}
	taken[strings.ToLower(name)] = true
	return name
}

// NormalizeFile converts an upload into validated .bin files under outDir
// without a cap on extracted archive size.
func NormalizeFile(srcPath, outDir string, ext string) ([]string, error) {
	return NormalizeFileLimit(srcPath, outDir, ext, 0)
}

// NormalizeFileLimit converts an upload into validated .bin files under
// outDir: .bin is copied, every CSV column becomes one .bin and every .bin
// member of a zip/tar archive is extracted. maxExtracted (bytes, 0 = no limit)
// caps the total size extracted from an archive.
func NormalizeFileLimit(srcPath, outDir string, ext string, maxExtracted int64) ([]string, error) {
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return nil, err
	}

	var paths []string
	var err error
	switch strings.ToLower(ext) {
	case ".bin":
		dest := filepath.Join(outDir, SafeName(strings.TrimSuffix(filepath.Base(srcPath), filepath.Ext(srcPath)), "input")+".bin")
		if err = copyFile(srcPath, dest); err == nil {
			paths = []string{dest}
		}
	case ".csv":
		paths, err = normalizeCSV(srcPath, outDir)
	case ".zip":
		paths, err = normalizeZip(srcPath, outDir, maxExtracted)
	case ".tar":
		paths, err = normalizeTar(srcPath, outDir, maxExtracted)
	default:
		return nil, fmt.Errorf("unsupported file extension: %s", ext)
	}
	if err != nil {
		return nil, err
	}

	for _, p := range paths {
		if _, err := ValidateBinFile(p); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
	}
	return paths, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// parseIntegerCell accepts integers and integral floats ("12", "12.0", "1e3").
func parseIntegerCell(cell string) (int64, error) {
	if v, err := strconv.ParseInt(cell, 10, 64); err == nil {
		return v, nil
	}
	f, err := strconv.ParseFloat(cell, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) ||
		f < math.MinInt64 || f >= math.MaxInt64 {
		return 0, fmt.Errorf("value %q is not an integer", cell)
	}
	return int64(f), nil
}

// csvColumn streams one CSV column into a .bin file; the header's value count
// is patched in once the column is complete.
type csvColumn struct {
	path string
	file *os.File
	w    *bufio.Writer
	n    uint64
}

func (c *csvColumn) close() error {
	if c.file == nil {
		return nil
	}
	err := c.w.Flush()
	if err == nil {
		var buf [8]byte
		binary.LittleEndian.PutUint64(buf[:], c.n)
		_, err = c.file.WriteAt(buf[:], 0)
	}
	if cerr := c.file.Close(); err == nil {
		err = cerr
	}
	c.file = nil
	return err
}

// normalizeCSV converts every column of a CSV with a header row into one .bin
// (standard header, decimals=0) in a single pass. Empty cells are skipped so
// columns may have different lengths; any other non-integer cell is an error.
func normalizeCSV(srcPath, outDir string) (paths []string, err error) {
	f, err := os.Open(srcPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	reader := csv.NewReader(bufio.NewReaderSize(f, 1<<20))
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = true
	reader.TrimLeadingSpace = true

	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read csv header: %w", err)
	}
	if len(header) == 0 {
		return nil, fmt.Errorf("csv has no columns")
	}
	if len(header) > MaxCSVColumns {
		return nil, fmt.Errorf("csv has %d columns; at most %d are supported", len(header), MaxCSVColumns)
	}

	taken := make(map[string]bool, len(header))
	columns := make([]*csvColumn, len(header))
	defer func() {
		for _, c := range columns {
			if c != nil {
				if cerr := c.close(); err == nil && cerr != nil {
					err = cerr
				}
			}
		}
	}()
	for i, raw := range header {
		name := uniqueName(SafeName(raw, fmt.Sprintf("col_%d", i)), taken)
		p := filepath.Join(outDir, name+".bin")
		file, err := os.Create(p)
		if err != nil {
			return nil, err
		}
		col := &csvColumn{path: p, file: file, w: bufio.NewWriterSize(file, 256<<10)}
		columns[i] = col
		if err := writeBinHeader(col.w, 0, 0); err != nil {
			return nil, err
		}
	}

	var buf [8]byte
	for line := 2; ; line++ {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read csv line %d: %w", line, err)
		}
		for i, cell := range record {
			if i >= len(columns) {
				return nil, fmt.Errorf("csv line %d has more fields than the header", line)
			}
			cell = strings.TrimSpace(cell)
			if cell == "" {
				continue
			}
			v, err := parseIntegerCell(cell)
			if err != nil {
				return nil, fmt.Errorf("csv line %d, column %q: %w", line, header[i], err)
			}
			binary.LittleEndian.PutUint64(buf[:], uint64(v))
			if _, err := columns[i].w.Write(buf[:]); err != nil {
				return nil, err
			}
			columns[i].n++
		}
	}

	for i, c := range columns {
		empty := c.n == 0
		if err := c.close(); err != nil {
			return nil, err
		}
		if empty {
			// Header-only columns carry no sequence.
			os.Remove(c.path)
			continue
		}
		paths = append(paths, columns[i].path)
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("csv has no data rows")
	}
	return paths, nil
}

// archiveMemberIsBin selects the .bin members of an archive, skipping macOS
// metadata (__MACOSX/, AppleDouble "._x.bin") and other hidden files.
func archiveMemberIsBin(name string) bool {
	clean := path.Clean(strings.ReplaceAll(name, "\\", "/"))
	base := path.Base(clean)
	if !strings.EqualFold(path.Ext(base), ".bin") || strings.HasPrefix(base, ".") {
		return false
	}
	for _, part := range strings.Split(clean, "/") {
		if part == "__MACOSX" {
			return false
		}
	}
	return true
}

// archiveMemberStem builds a unique file stem from the member path, so
// a/x.bin and b/x.bin do not overwrite each other.
func archiveMemberStem(name string, taken map[string]bool) string {
	base := path.Base(strings.ReplaceAll(name, "\\", "/"))
	return uniqueName(SafeName(strings.TrimSuffix(base, path.Ext(base)), "member"), taken)
}

// extractLimited copies r into dest, failing once the archive-wide budget is
// exhausted.
func extractLimited(r io.Reader, dest string, remaining *int64, limited bool) error {
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	src := r
	if limited {
		src = io.LimitReader(r, *remaining+1)
	}
	n, err := io.Copy(out, src)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if limited {
		*remaining -= n
		if *remaining < 0 {
			return errExtractionLimit
		}
	}
	return nil
}

func normalizeZip(srcPath, outDir string, maxExtracted int64) ([]string, error) {
	reader, err := zip.OpenReader(srcPath)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	remaining := maxExtracted
	limited := maxExtracted > 0
	taken := make(map[string]bool)
	var paths []string
	for _, f := range reader.File {
		if !f.Mode().IsRegular() || !archiveMemberIsBin(f.Name) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		dest := filepath.Join(outDir, archiveMemberStem(f.Name, taken)+".bin")
		err = extractLimited(rc, dest, &remaining, limited)
		rc.Close()
		if err != nil {
			return nil, limitError(err, maxExtracted)
		}
		paths = append(paths, dest)
	}

	if len(paths) == 0 {
		return nil, fmt.Errorf("zip contains no .bin files")
	}
	return paths, nil
}

func normalizeTar(srcPath, outDir string, maxExtracted int64) ([]string, error) {
	f, err := os.Open(srcPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	remaining := maxExtracted
	limited := maxExtracted > 0
	taken := make(map[string]bool)
	reader := tar.NewReader(f)
	var paths []string
	for {
		hdr, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		// Regular files only: symlinks and devices would yield empty or
		// unrelated content.
		if hdr.Typeflag != tar.TypeReg || !archiveMemberIsBin(hdr.Name) {
			continue
		}

		dest := filepath.Join(outDir, archiveMemberStem(hdr.Name, taken)+".bin")
		if err := extractLimited(reader, dest, &remaining, limited); err != nil {
			return nil, limitError(err, maxExtracted)
		}
		paths = append(paths, dest)
	}

	if len(paths) == 0 {
		return nil, fmt.Errorf("tar contains no .bin files")
	}
	return paths, nil
}

var errExtractionLimit = errors.New("archive extraction limit exceeded")

func limitError(err error, maxExtracted int64) error {
	if errors.Is(err, errExtractionLimit) {
		return fmt.Errorf("archive expands beyond the %d MB extraction limit", maxExtracted/(1024*1024))
	}
	return err
}
