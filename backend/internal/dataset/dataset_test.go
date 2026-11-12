package dataset

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"bitbench/internal/seqfile"
)

func TestSelectEvenlyMatchesNumpy(t *testing.T) {
	// Reference: numpy.linspace(0, total-1, max).round().astype(int), the
	// selection used by convert_ds_full.py for the thesis datasets.
	cases := []struct {
		total, max int
		want       []int
	}{
		{130, 10, []int{0, 14, 29, 43, 57, 72, 86, 100, 115, 129}},
		{57, 10, []int{0, 6, 12, 19, 25, 31, 37, 44, 50, 56}},
		{11, 10, []int{0, 1, 2, 3, 4, 6, 7, 8, 9, 10}},
		{1000, 7, []int{0, 166, 333, 500, 666, 832, 999}},
		{20, 3, []int{0, 10, 19}},
		{5, 2, []int{0, 4}},
		{4, 10, []int{0, 1, 2, 3}},
		{4, 0, []int{0, 1, 2, 3}},
	}
	for _, c := range cases {
		if got := SelectEvenly(c.total, c.max); !reflect.DeepEqual(got, c.want) {
			t.Errorf("SelectEvenly(%d, %d) = %v, want %v", c.total, c.max, got, c.want)
		}
	}
}

func writeSeries(t *testing.T, root, dataset, series string, values []int64, decimals uint64) {
	t.Helper()
	dir := filepath.Join(root, dataset)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := seqfile.WriteBinFile(filepath.Join(dir, series+".bin"), values, decimals); err != nil {
		t.Fatal(err)
	}
}

func readValues(t *testing.T, p string) []int64 {
	t.Helper()
	info, err := seqfile.ReadBinFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return info.Values
}

func TestMaterializeTransforms(t *testing.T) {
	root := t.TempDir()
	// Two chunks of 4 plus a discarded partial chunk of 1.
	writeSeries(t, root, "ds", "sig", []int64{10, 12, 9, 9, -5, -3, -8, 0, 99}, 1)

	cases := map[string][][]int64{
		TransformStd: {{10, 12, 9, 9}, {-5, -3, -8, 0}},
		TransformGap: {{10, 2, -3, 0}, {-5, 2, -5, 8}},
		// x0 - min(x), then deltas minus the minimum delta.
		TransformGapShifted: {{1, 5, 0, 3}, {3, 7, 0, 13}},
	}
	for transform, want := range cases {
		out := filepath.Join(t.TempDir(), transform)
		outputs, err := Materialize(root, "ds", "sig", ChunkPlan{ChunkSize: 4, Transform: transform}, out, nil)
		if err != nil {
			t.Fatalf("%s: %v", transform, err)
		}
		if len(outputs) != 2 {
			t.Fatalf("%s: got %d chunks, want 2 (partial chunk discarded)", transform, len(outputs))
		}
		for i, o := range outputs {
			got := readValues(t, o.Path)
			if !reflect.DeepEqual(got, want[i]) {
				t.Errorf("%s chunk %d = %v, want %v", transform, i, got, want[i])
			}
			if transform == TransformGapShifted {
				for _, v := range got {
					if v < 0 {
						t.Errorf("gap_shifted produced a negative value: %v", got)
					}
				}
			}
			info, _ := seqfile.ReadBinFile(o.Path)
			if info.Decimals != 1 {
				t.Errorf("decimals not propagated: %d", info.Decimals)
			}
		}
	}
}

func TestMaterializeWholeSeriesAndMaxChunks(t *testing.T) {
	root := t.TempDir()
	values := make([]int64, 100)
	for i := range values {
		values[i] = int64(i * i)
	}
	writeSeries(t, root, "ds", "s", values, 0)

	whole, err := Materialize(root, "ds", "s", ChunkPlan{Transform: TransformStd}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(whole) != 1 || !reflect.DeepEqual(readValues(t, whole[0].Path), values) {
		t.Fatalf("whole series not reproduced")
	}

	limited, err := Materialize(root, "ds", "s", ChunkPlan{ChunkSize: 10, MaxChunks: 3, Transform: TransformStd}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var chunks []int
	for _, o := range limited {
		chunks = append(chunks, o.Chunk)
	}
	if !reflect.DeepEqual(chunks, []int{0, 4, 9}) {
		t.Fatalf("selected chunks %v, want [0 4 9]", chunks)
	}
	if got := readValues(t, limited[1].Path); got[0] != 40*40 {
		t.Fatalf("chunk 4 starts at %d, want %d", got[0], 40*40)
	}
}

func TestScanListsValidAndInvalidSeries(t *testing.T) {
	root := t.TempDir()
	writeSeries(t, root, "finance", "NVDA", []int64{1, 2, 3}, 2)
	os.WriteFile(filepath.Join(root, "finance", "broken.bin"), []byte("nope"), 0644)
	os.WriteFile(filepath.Join(root, "finance", "dataset.yaml"), []byte("description: Daily closes\nsource: example\n"), 0644)
	os.MkdirAll(filepath.Join(root, "empty"), 0755)
	os.MkdirAll(filepath.Join(root, ".hidden"), 0755)

	datasets, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(datasets) != 1 || datasets[0].Name != "finance" {
		t.Fatalf("got %+v, want only finance", datasets)
	}
	ds := datasets[0]
	if ds.Description != "Daily closes" || len(ds.Series) != 2 {
		t.Fatalf("unexpected dataset %+v", ds)
	}
	nvda, _ := ds.Find("NVDA")
	if nvda.Values != 3 || nvda.Decimals != 2 || nvda.Error != "" {
		t.Fatalf("NVDA = %+v", nvda)
	}
	broken, _ := ds.Find("broken")
	if broken.Error == "" {
		t.Fatal("invalid series must report an error")
	}

	if missing, err := Scan(filepath.Join(root, "nope")); err != nil || len(missing) != 0 {
		t.Fatalf("missing root should yield no datasets, got %v %v", missing, err)
	}
}

func TestPlanValidation(t *testing.T) {
	if err := (ChunkPlan{Transform: "zigzag"}).Validate(); err == nil {
		t.Error("unknown transform must be rejected")
	}
	if err := (ChunkPlan{ChunkSize: 1, Transform: TransformStd}).Validate(); err == nil {
		t.Error("chunk size 1 must be rejected")
	}
	if !ValidName("NVDA") || ValidName("../etc") || ValidName(".hidden") {
		t.Error("name validation")
	}
	if PlannedChunks(100, ChunkPlan{ChunkSize: 30, MaxChunks: 2}) != 2 || PlannedChunks(100, ChunkPlan{}) != 1 {
		t.Error("PlannedChunks")
	}
}
