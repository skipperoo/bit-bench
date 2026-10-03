package compressor

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	maxArchiveFiles = 5000
	specFilename    = "spec.yaml"
)

// ExtractZipFile extracts archivePath into destDir, rejecting entries that
// would escape destDir, symlinks, and archives that exceed maxTotalBytes.
func ExtractZipFile(archivePath, destDir string, maxTotalBytes int64) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer reader.Close()

	if len(reader.File) > maxArchiveFiles {
		return fmt.Errorf("archive contains too many files (%d)", len(reader.File))
	}

	var total int64
	for _, file := range reader.File {
		cleaned, err := safeZipPath(file.Name)
		if err != nil {
			return err
		}
		if cleaned == "" {
			continue
		}

		if file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("archive contains a symlink: %s", file.Name)
		}

		target := filepath.Join(destDir, filepath.FromSlash(cleaned))
		if !strings.HasPrefix(target, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry escapes destination: %s", file.Name)
		}

		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0755); err != nil {
				return fmt.Errorf("mkdir %s: %w", cleaned, err)
			}
			continue
		}

		total += int64(file.UncompressedSize64)
		if maxTotalBytes > 0 && total > maxTotalBytes {
			return fmt.Errorf("archive exceeds uncompressed size limit")
		}

		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(cleaned), err)
		}

		src, err := file.Open()
		if err != nil {
			return fmt.Errorf("open entry %s: %w", cleaned, err)
		}
		if err := writeZipEntry(src, target, file.Mode().Perm()); err != nil {
			src.Close()
			return err
		}
		src.Close()
	}
	return nil
}

func writeZipEntry(src io.Reader, target string, perm os.FileMode) error {
	if perm == 0 {
		perm = 0644
	}
	perm = perm & 0755
	if perm&0600 != 0600 {
		perm |= 0600
	}

	dst, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("create %s: %w", target, err)
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("write %s: %w", target, err)
	}
	return nil
}

// safeZipPath normalizes a zip entry name and rejects traversal attempts.
func safeZipPath(name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == "/" {
		return "", nil
	}
	if path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("archive entry escapes destination: %s", name)
	}
	return cleaned, nil
}
