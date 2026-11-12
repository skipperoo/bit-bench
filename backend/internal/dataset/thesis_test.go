package dataset

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestThesisEquivalence checks that cutting exported full series reproduces
// the pre-cut thesis chunk files byte for byte. It is opt-in:
//
//	BITBENCH_FULL_DATASETS=<dir with wildppg/*.bin> \
//	BITBENCH_THESIS_DATASETS=<gef-experiments/datasets> go test ./internal/dataset -run Thesis
//
// Thesis size_<B> folders hold chunks of B/2 samples, at most 10 per signal,
// named <prefix>_<series>_<k>.bin where k is the position in the selection.
func TestThesisEquivalence(t *testing.T) {
	full := os.Getenv("BITBENCH_FULL_DATASETS")
	thesis := os.Getenv("BITBENCH_THESIS_DATASETS")
	if full == "" || thesis == "" {
		t.Skip("set BITBENCH_FULL_DATASETS and BITBENCH_THESIS_DATASETS to compare with the thesis chunks")
	}
	datasetName := os.Getenv("BITBENCH_THESIS_PREFIX")
	if datasetName == "" {
		datasetName = "wildppg"
	}
	ds, err := Load(full, datasetName)
	if err != nil {
		t.Fatal(err)
	}

	compared := 0
	for _, transform := range []string{TransformStd, TransformGap} {
		sizes, _ := filepath.Glob(filepath.Join(thesis, transform, "size_*"))
		sort.Strings(sizes)
		for _, sizeDir := range sizes {
			var bytesSize uint64
			fmt.Sscanf(filepath.Base(sizeDir), "size_%d", &bytesSize)
			plan := ChunkPlan{ChunkSize: bytesSize / 2, MaxChunks: 10, Transform: transform}
			for _, s := range ds.Series {
				out := t.TempDir()
				outputs, err := Materialize(full, datasetName, s.Name, plan, out, nil)
				if err != nil {
					t.Fatalf("%s %s: %v", transform, s.Name, err)
				}
				for k, o := range outputs {
					ref := filepath.Join(sizeDir, fmt.Sprintf("%s_%s_%d.bin", datasetName, s.Name, k))
					want, err := os.ReadFile(ref)
					if err != nil {
						t.Fatalf("missing thesis chunk %s", ref)
					}
					got, _ := os.ReadFile(o.Path)
					if !bytes.Equal(got, want) {
						t.Errorf("%s differs from %s (chunk index %d)", ref, strings.TrimPrefix(o.Path, out), o.Chunk)
					}
					compared++
				}
			}
		}
	}
	if compared == 0 {
		t.Fatal("nothing compared")
	}
	t.Logf("compared %d chunk files: identical", compared)
}
