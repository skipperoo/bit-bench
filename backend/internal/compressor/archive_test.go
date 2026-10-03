package compressor

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func writeZip(t *testing.T, entries []zipEntry) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pkg.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create zip: %v", err)
	}
	zw := zip.NewWriter(f)
	for _, e := range entries {
		hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.symlink {
			hdr.SetMode(os.ModeSymlink | 0777)
		} else if e.exec {
			hdr.SetMode(0755)
		} else {
			hdr.SetMode(0644)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatalf("create entry: %v", err)
		}
		if _, err := w.Write([]byte(e.content)); err != nil {
			t.Fatalf("write entry: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	f.Close()
	return path
}

type zipEntry struct {
	name    string
	content string
	exec    bool
	symlink bool
}

func TestExtractZipFile(t *testing.T) {
	archive := writeZip(t, []zipEntry{
		{name: "spec.yaml", content: "name: codec\n"},
		{name: "src/", content: ""},
		{name: "src/main.py", content: "print('hi')\n"},
		{name: "build/run.sh", content: "#!/bin/sh\n", exec: true},
	})
	dest := t.TempDir()

	if err := ExtractZipFile(archive, dest, 0); err != nil {
		t.Fatalf("ExtractZipFile: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dest, "src", "main.py"))
	if err != nil || string(data) != "print('hi')\n" {
		t.Errorf("main.py = %q, err = %v", data, err)
	}

	info, err := os.Stat(filepath.Join(dest, "build", "run.sh"))
	if err != nil {
		t.Fatalf("stat run.sh: %v", err)
	}
	if info.Mode().Perm()&0100 == 0 {
		t.Errorf("exec bit not preserved: %v", info.Mode())
	}
}

func TestExtractZipFileRejectsTraversal(t *testing.T) {
	for _, name := range []string{"../evil.txt", "a/../../evil.txt", "/abs/evil.txt"} {
		t.Run(name, func(t *testing.T) {
			archive := writeZip(t, []zipEntry{{name: name, content: "x"}})
			err := ExtractZipFile(archive, t.TempDir(), 0)
			if err == nil {
				t.Fatal("expected traversal error")
			}
		})
	}
}

func TestExtractZipFileRejectsSymlink(t *testing.T) {
	archive := writeZip(t, []zipEntry{{name: "link", content: "/etc/passwd", symlink: true}})
	err := ExtractZipFile(archive, t.TempDir(), 0)
	if err == nil {
		t.Fatal("expected symlink error")
	}
}

func TestExtractZipFileSizeLimit(t *testing.T) {
	archive := writeZip(t, []zipEntry{{name: "big.bin", content: string(bytes.Repeat([]byte("a"), 1024))}})
	err := ExtractZipFile(archive, t.TempDir(), 10)
	if err == nil {
		t.Fatal("expected size limit error")
	}
}
