// Package dataset exposes the standardized datasets mounted at DATASET_DIR
// and materializes benchmark inputs from them.
//
// Layout: DATASET_DIR/<dataset>/<series>.bin, one full recording per file in
// the BitBench .bin format (8- or 16-byte header, int64 values). Any integer
// data works: sensor channels (wildppg/wrist_ppg_g.bin), price ticks
// (finance/NVDA.bin), ... An optional DATASET_DIR/<dataset>/dataset.yaml adds
// a description and source.
package dataset

import (
	"bytes"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"bitbench/internal/seqfile"
)

// Transforms applied to every chunk before benchmarking (thesis "std", "gap"
// and "gap_shifted" dataset variants).
const (
	TransformStd        = "std"
	TransformGap        = "gap"
	TransformGapShifted = "gap_shifted"
)

// Transforms lists the supported transforms in display order.
var Transforms = []string{TransformStd, TransformGap, TransformGapShifted}

// Limits that keep one request from generating unbounded work.
const (
	MaxChunksPerSeries = 10000
	MaxInputsPerRun    = 5000
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

// ValidName reports whether a dataset or series name is safe to use as a
// path component.
func ValidName(name string) bool {
	return nameRe.MatchString(name) && !strings.Contains(name, "..")
}

// Series is one full recording of a dataset.
type Series struct {
	Name      string `json:"name"`
	Values    uint64 `json:"values"`
	Decimals  uint64 `json:"decimals"`
	SizeBytes int64  `json:"size_bytes"`
	// Error is set when the file is not a valid .bin; such series are listed
	// so the operator sees the problem but cannot be selected.
	Error string `json:"error,omitempty"`
}

// Dataset is one directory of series.
type Dataset struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Source      string   `json:"source,omitempty"`
	Series      []Series `json:"series"`
}

type metadata struct {
	Description string `yaml:"description"`
	Source      string `yaml:"source"`
}

// Scan lists the datasets under root. A missing root yields no datasets.
func Scan(root string) ([]Dataset, error) {
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return []Dataset{}, nil
	}
	if err != nil {
		return nil, err
	}

	datasets := []Dataset{}
	for _, e := range entries {
		if !e.IsDir() || !ValidName(e.Name()) {
			continue
		}
		ds, err := Load(root, e.Name())
		if err != nil || len(ds.Series) == 0 {
			continue
		}
		datasets = append(datasets, *ds)
	}
	sort.Slice(datasets, func(i, j int) bool { return datasets[i].Name < datasets[j].Name })
	return datasets, nil
}

// Load reads one dataset directory.
func Load(root, name string) (*Dataset, error) {
	if !ValidName(name) {
		return nil, fmt.Errorf("invalid dataset name %q", name)
	}
	dir := filepath.Join(root, name)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("dataset %q not found", name)
	}

	ds := &Dataset{Name: name, Series: []Series{}}
	if raw, err := os.ReadFile(filepath.Join(dir, "dataset.yaml")); err == nil {
		var meta metadata
		if yaml.Unmarshal(raw, &meta) == nil {
			ds.Description = strings.TrimSpace(meta.Description)
			ds.Source = strings.TrimSpace(meta.Source)
		}
	}

	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".bin") {
			continue
		}
		seriesName := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		if !ValidName(seriesName) {
			continue
		}
		s := Series{Name: seriesName}
		if info, err := e.Info(); err == nil {
			s.SizeBytes = info.Size()
		}
		h, err := seqfile.ValidateBinFile(filepath.Join(dir, e.Name()))
		if err != nil {
			s.Error = err.Error()
		} else {
			s.Values, s.Decimals = h.N, h.Decimals
		}
		ds.Series = append(ds.Series, s)
	}
	sort.Slice(ds.Series, func(i, j int) bool { return ds.Series[i].Name < ds.Series[j].Name })
	return ds, nil
}

// Find returns the series of ds with the given name.
func (ds *Dataset) Find(name string) (*Series, bool) {
	for i := range ds.Series {
		if ds.Series[i].Name == name {
			return &ds.Series[i], true
		}
	}
	return nil, false
}

// seriesPath locates the file of a series (the extension may differ in case).
func seriesPath(root, dataset, series string) (string, error) {
	dir := filepath.Join(root, dataset)
	for _, ext := range []string{".bin", ".BIN", ".Bin"} {
		p := filepath.Join(dir, series+ext)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("series %s/%s not found", dataset, series)
}

// ChunkPlan describes how to cut one series.
type ChunkPlan struct {
	ChunkSize uint64 // samples per chunk; 0 = the whole series
	MaxChunks int    // evenly spaced chunks to keep; 0 = all
	Transform string
}

// ChunkCount returns how many full chunks a series of n values yields
// (a trailing partial chunk is discarded, as in the thesis datasets).
func ChunkCount(n, chunkSize uint64) uint64 {
	if chunkSize == 0 {
		if n == 0 {
			return 0
		}
		return 1
	}
	return n / chunkSize
}

// SelectEvenly returns the indices of at most max chunks out of total, spread
// over the whole recording. It mirrors numpy's
// linspace(0, total-1, max).round() (round half to even) used to build the
// thesis datasets, so chunk selections are identical.
func SelectEvenly(total, max int) []int {
	if total <= 0 {
		return nil
	}
	if max <= 0 || total <= max {
		idx := make([]int, total)
		for i := range idx {
			idx[i] = i
		}
		return idx
	}
	idx := make([]int, max)
	if max == 1 {
		return []int{0}
	}
	step := float64(total-1) / float64(max-1)
	for i := range idx {
		idx[i] = int(math.RoundToEven(float64(i) * step))
	}
	idx[max-1] = total - 1
	return idx
}

// Extended reports whether a series of n values is shorter than one chunk and
// is therefore repeated (concatenated with itself) to fill a single chunk.
func Extended(n, chunkSize uint64) bool {
	return chunkSize > 0 && n > 0 && n < chunkSize
}

// PlannedChunks returns how many inputs a plan produces for a series.
func PlannedChunks(n uint64, plan ChunkPlan) int {
	if Extended(n, plan.ChunkSize) {
		return 1
	}
	total := ChunkCount(n, plan.ChunkSize)
	if total > math.MaxInt32 {
		total = math.MaxInt32
	}
	if plan.MaxChunks > 0 && int(total) > plan.MaxChunks {
		return plan.MaxChunks
	}
	return int(total)
}

// Validate checks a plan's parameters.
func (p ChunkPlan) Validate() error {
	switch p.Transform {
	case TransformStd, TransformGap, TransformGapShifted:
	default:
		return fmt.Errorf("unknown transform %q (want std, gap or gap_shifted)", p.Transform)
	}
	if p.ChunkSize == 1 {
		return fmt.Errorf("chunk size must be 0 (whole series) or at least 2 samples")
	}
	if p.MaxChunks < 0 || p.MaxChunks > MaxChunksPerSeries {
		return fmt.Errorf("max chunks must be between 0 (all) and %d", MaxChunksPerSeries)
	}
	return nil
}

// Output is one materialized benchmark input.
type Output struct {
	Path   string
	Series string
	Chunk  int // chunk index within the series (0 for the whole series)
	Values uint64
}

// Materialize cuts one series according to plan and writes one standard .bin
// per selected chunk into outDir, feeding every written byte to hash. Files
// are named <series>_<chunk>.bin, like the thesis datasets. A series shorter
// than one chunk is repeated until it fills exactly one chunk.
func Materialize(root, datasetName, seriesName string, plan ChunkPlan, outDir string, hash io.Writer) ([]Output, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	src, err := seriesPath(root, datasetName, seriesName)
	if err != nil {
		return nil, err
	}
	h, err := seqfile.ValidateBinFile(src)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", datasetName, seriesName, err)
	}
	f, err := os.Open(src)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	chunkLen := plan.ChunkSize
	if chunkLen == 0 {
		chunkLen = h.N
	}
	if Extended(h.N, plan.ChunkSize) {
		return materializeExtended(f, h, seriesName, chunkLen, plan.Transform, outDir, hash)
	}
	total := ChunkCount(h.N, plan.ChunkSize)
	if total == 0 {
		return nil, fmt.Errorf("%s/%s has %d values, fewer than one chunk of %d", datasetName, seriesName, h.N, plan.ChunkSize)
	}
	if total > math.MaxInt32 {
		return nil, fmt.Errorf("%s/%s: too many chunks", datasetName, seriesName)
	}
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return nil, err
	}

	var outputs []Output
	for _, idx := range SelectEvenly(int(total), plan.MaxChunks) {
		start := uint64(idx) * chunkLen
		dest := filepath.Join(outDir, fmt.Sprintf("%s_%d.bin", seriesName, idx))
		reader := &valueReader{r: f, offset: h.HeaderSize + int64(start)*8, count: chunkLen}
		if err := writeChunk(dest, reader, chunkLen, h.Decimals, plan.Transform, hash); err != nil {
			return nil, fmt.Errorf("%s/%s chunk %d: %w", datasetName, seriesName, idx, err)
		}
		outputs = append(outputs, Output{Path: dest, Series: seriesName, Chunk: idx, Values: chunkLen})
	}
	return outputs, nil
}

// materializeExtended writes one chunk of chunkLen values made of the series
// repeated from its start (the series is shorter than a chunk, so it fits in
// memory: at most chunkLen values).
func materializeExtended(f io.ReaderAt, h seqfile.BinHeader, seriesName string, chunkLen uint64, transform, outDir string, hash io.Writer) ([]Output, error) {
	values := make([]byte, h.N*8)
	if _, err := f.ReadAt(values, h.HeaderSize); err != nil {
		return nil, err
	}
	repeats := int((chunkLen + h.N - 1) / h.N)
	tiled := bytes.Repeat(values, repeats)[:chunkLen*8]
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return nil, err
	}
	dest := filepath.Join(outDir, seriesName+"_0.bin")
	reader := &valueReader{r: bytes.NewReader(tiled), count: chunkLen}
	if err := writeChunk(dest, reader, chunkLen, h.Decimals, transform, hash); err != nil {
		return nil, fmt.Errorf("%s (extended): %w", seriesName, err)
	}
	return []Output{{Path: dest, Series: seriesName, Values: chunkLen}}, nil
}

// valueReader streams int64 values from a byte range of a .bin file.
type valueReader struct {
	r      io.ReaderAt
	offset int64
	count  uint64
}

// each calls fn for every value in order.
func (v *valueReader) each(fn func(int64)) error {
	const batch = 64 * 1024
	buf := make([]byte, batch*8)
	remaining := v.count
	off := v.offset
	for remaining > 0 {
		n := uint64(batch)
		if remaining < n {
			n = remaining
		}
		chunk := buf[:n*8]
		if _, err := v.r.ReadAt(chunk, off); err != nil {
			return err
		}
		for i := uint64(0); i < n; i++ {
			fn(int64(binary.LittleEndian.Uint64(chunk[i*8:])))
		}
		off += int64(n * 8)
		remaining -= n
	}
	return nil
}

// gapShiftOffsets scans a chunk for the gap_shifted offsets: the minimum value
// (anchor for the first element) and the minimum delta.
func gapShiftOffsets(r *valueReader) (minValue, minDelta int64, err error) {
	minValue, minDelta = math.MaxInt64, math.MaxInt64
	var prev int64
	first := true
	err = r.each(func(x int64) {
		if x < minValue {
			minValue = x
		}
		if !first {
			if d := x - prev; d < minDelta {
				minDelta = d
			}
		}
		prev, first = x, false
	})
	if minDelta == math.MaxInt64 { // single-value chunk
		minDelta = 0
	}
	return minValue, minDelta, err
}

// writeChunk writes count values from r, transformed, as a standard .bin.
//
//	std:          x[i]
//	gap:          x[0], x[i] - x[i-1]                      (thesis "gap")
//	gap_shifted:  x[0] - min(x), (x[i] - x[i-1]) - min(Δ)  (every value >= 0)
//
// The two gap_shifted offsets are side information that the .bin format has
// no room for; they are not stored (16 bytes per chunk if a decoder needed
// them).
func writeChunk(dest string, r *valueReader, count, decimals uint64, transform string, hash io.Writer) error {
	var minValue, minDelta int64
	if transform == TransformGapShifted {
		var err error
		if minValue, minDelta, err = gapShiftOffsets(r); err != nil {
			return err
		}
	}

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	var w io.Writer = out
	if hash != nil {
		w = io.MultiWriter(out, hash)
	}
	bw := newBufferedWriter(w)

	var header [16]byte
	binary.LittleEndian.PutUint64(header[0:8], count)
	binary.LittleEndian.PutUint64(header[8:16], decimals)
	bw.write(header[:])

	var prev int64
	first := true
	var buf [8]byte
	err = r.each(func(x int64) {
		v := x
		switch transform {
		case TransformGap:
			if !first {
				v = x - prev
			}
		case TransformGapShifted:
			if first {
				v = x - minValue
			} else {
				v = x - prev - minDelta
			}
		}
		prev, first = x, false
		binary.LittleEndian.PutUint64(buf[:], uint64(v))
		bw.write(buf[:])
	})
	if err == nil {
		err = bw.flush()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// bufferedWriter is a minimal buffered writer that remembers the first error.
type bufferedWriter struct {
	w   io.Writer
	buf []byte
	err error
}

func newBufferedWriter(w io.Writer) *bufferedWriter {
	return &bufferedWriter{w: w, buf: make([]byte, 0, 1<<20)}
}

func (b *bufferedWriter) write(p []byte) {
	if b.err != nil {
		return
	}
	if len(b.buf)+len(p) > cap(b.buf) {
		b.err = b.flush()
	}
	b.buf = append(b.buf, p...)
}

func (b *bufferedWriter) flush() error {
	if b.err != nil {
		return b.err
	}
	if len(b.buf) > 0 {
		_, b.err = b.w.Write(b.buf)
		b.buf = b.buf[:0]
	}
	return b.err
}

// NewHash returns the hash used for benchmark checksums of generated inputs.
func NewHash() (io.Writer, func() string) {
	h := md5.New()
	return h, func() string { return hex.EncodeToString(h.Sum(nil)) }
}

// Preview summarizes one series for the datasets browser: the value range
// over the whole recording and a min/max-per-bucket sparkline of its first
// `head` values (so spikes stay visible after downsampling).
type Preview struct {
	Values   uint64  `json:"values"`
	Decimals uint64  `json:"decimals"`
	Min      int64   `json:"min"`
	Max      int64   `json:"max"`
	Mean     float64 `json:"mean"`
	// Head is the number of leading values the sparkline covers.
	Head uint64 `json:"head"`
	// Sparkline holds (min, max) pairs, one per bucket.
	Sparkline [][2]int64 `json:"sparkline"`
}

// PreviewSeries computes the preview of a series; points is the sparkline
// width in buckets.
func PreviewSeries(root, datasetName, seriesName string, head uint64, points int) (*Preview, error) {
	if !ValidName(datasetName) || !ValidName(seriesName) {
		return nil, fmt.Errorf("invalid name")
	}
	src, err := seriesPath(root, datasetName, seriesName)
	if err != nil {
		return nil, err
	}
	h, err := seqfile.ValidateBinFile(src)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(src)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	p := &Preview{Values: h.N, Decimals: h.Decimals, Min: math.MaxInt64, Max: math.MinInt64}
	if head == 0 || head > h.N {
		head = h.N
	}
	p.Head = head
	if points < 1 {
		points = 1
	}
	if uint64(points) > head {
		points = int(head)
	}
	bucket := (head + uint64(points) - 1) / uint64(points)
	p.Sparkline = make([][2]int64, 0, points)

	var sum float64
	var i uint64
	cur := [2]int64{math.MaxInt64, math.MinInt64}
	err = (&valueReader{r: f, offset: h.HeaderSize, count: h.N}).each(func(v int64) {
		if v < p.Min {
			p.Min = v
		}
		if v > p.Max {
			p.Max = v
		}
		sum += float64(v)
		if i < head {
			cur[0] = min(cur[0], v)
			cur[1] = max(cur[1], v)
			if (i+1)%bucket == 0 || i+1 == head {
				p.Sparkline = append(p.Sparkline, cur)
				cur = [2]int64{math.MaxInt64, math.MinInt64}
			}
		}
		i++
	})
	if err != nil {
		return nil, err
	}
	p.Mean = sum / float64(h.N)
	return p, nil
}
