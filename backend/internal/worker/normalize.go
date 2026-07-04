package worker

import (
	"archive/tar"
	"archive/zip"
	"encoding/binary"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type BinInfo struct {
	Path     string
	N        uint64
	Decimals uint64
	Values   []int64
}

// DetectBinFormat determines the .bin header format (8-byte or 16-byte).
// Returns the number of values and the decimal count.
// Prefers 16-byte (standard) when both formats match.
func DetectBinFormat(data []byte) (n uint64, decimals uint64, err error) {
	fs := len(data)

	// Check if 16-byte format matches
	if fs >= 16 && (fs-16)%8 == 0 {
		dec := binary.LittleEndian.Uint64(data[8:16])
		return uint64((fs - 16) / 8), dec, nil
	}

	// Fall back to 8-byte (simple) format
	if fs >= 8 && (fs-8)%8 == 0 {
		return uint64((fs - 8) / 8), 0, nil
	}

	return 0, 0, fmt.Errorf("invalid .bin file size: %d bytes", fs)
}

func ReadBinFile(path string) (*BinInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	n, decimals, err := DetectBinFormat(data)
	if err != nil {
		return nil, err
	}

	offset := 16
	if len(data) == 8+int(n)*8 {
		offset = 8
	}

	values := make([]int64, n)
	for i := uint64(0); i < n; i++ {
		values[i] = int64(binary.LittleEndian.Uint64(data[offset+int(i*8):]))
	}

	return &BinInfo{
		Path:     path,
		N:        n,
		Decimals: decimals,
		Values:   values,
	}, nil
}

func WriteBinFile(path string, values []int64, decimals uint64) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	n := uint64(len(values))
	header := make([]byte, 16)
	binary.LittleEndian.PutUint64(header[0:8], n)
	binary.LittleEndian.PutUint64(header[8:16], decimals)
	if _, err := f.Write(header); err != nil {
		return err
	}

	buf := make([]byte, 8*n)
	for i, v := range values {
		binary.LittleEndian.PutUint64(buf[i*8:], uint64(v))
	}
	_, err = f.Write(buf)
	return err
}

func CSVToBin(csvPath, outDir, columnName string, columnIdx int) (string, error) {
	f, err := os.Open(csvPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	records, err := reader.ReadAll()
	if err != nil {
		return "", fmt.Errorf("read csv: %w", err)
	}
	if len(records) < 2 {
		return "", fmt.Errorf("csv has no data rows")
	}

	var values []int64
	for i := 1; i < len(records); i++ {
		if columnIdx < len(records[i]) {
			var v int64
			if _, err := fmt.Sscanf(strings.TrimSpace(records[i][columnIdx]), "%d", &v); err == nil {
				values = append(values, v)
			}
		}
	}

	outPath := filepath.Join(outDir, columnName+".bin")
	return outPath, WriteBinFile(outPath, values, 0)
}

func NormalizeFile(srcPath, outDir string, ext string) ([]string, error) {
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return nil, err
	}

	switch ext {
	case ".bin":
		destPath := filepath.Join(outDir, filepath.Base(srcPath))
		src, err := os.Open(srcPath)
		if err != nil {
			return nil, err
		}
		defer src.Close()
		dst, err := os.Create(destPath)
		if err != nil {
			return nil, err
		}
		defer dst.Close()
		if _, err := io.Copy(dst, src); err != nil {
			return nil, err
		}
		return []string{destPath}, nil

	case ".csv":
		return normalizeCSV(srcPath, outDir)

	case ".zip":
		return normalizeZip(srcPath, outDir)

	case ".tar":
		return normalizeTar(srcPath, outDir)

	default:
		return nil, fmt.Errorf("unsupported file extension: %s", ext)
	}
}

func normalizeCSV(srcPath, outDir string) ([]string, error) {
	f, err := os.Open(srcPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read csv header: %w", err)
	}

	var paths []string
	for i, colName := range header {
		colName = strings.TrimSpace(colName)
		if colName == "" {
			colName = fmt.Sprintf("col_%d", i)
		}
		path, err := CSVToBin(srcPath, outDir, colName, i)
		if err != nil {
			return nil, fmt.Errorf("convert column %s: %w", colName, err)
		}
		paths = append(paths, path)
	}

	if len(paths) == 0 {
		return nil, fmt.Errorf("csv has no columns")
	}
	return paths, nil
}

func normalizeZip(srcPath, outDir string) ([]string, error) {
	reader, err := zip.OpenReader(srcPath)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	var paths []string
	for _, f := range reader.File {
		if f.FileInfo().IsDir() || !strings.HasSuffix(f.Name, ".bin") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}

		destPath := filepath.Join(outDir, filepath.Base(f.Name))
		dst, err := os.Create(destPath)
		if err != nil {
			rc.Close()
			return nil, err
		}
		_, err = io.Copy(dst, rc)
		rc.Close()
		dst.Close()
		if err != nil {
			return nil, err
		}
		paths = append(paths, destPath)
	}

	if len(paths) == 0 {
		return nil, fmt.Errorf("zip contains no .bin files")
	}
	return paths, nil
}

func normalizeTar(srcPath, outDir string) ([]string, error) {
	f, err := os.Open(srcPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

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
		if hdr.FileInfo().IsDir() || !strings.HasSuffix(hdr.Name, ".bin") {
			continue
		}

		destPath := filepath.Join(outDir, filepath.Base(hdr.Name))
		dst, err := os.Create(destPath)
		if err != nil {
			return nil, err
		}
		_, err = io.Copy(dst, reader)
		dst.Close()
		if err != nil {
			return nil, err
		}
		paths = append(paths, destPath)
	}

	if len(paths) == 0 {
		return nil, fmt.Errorf("tar contains no .bin files")
	}
	return paths, nil
}
