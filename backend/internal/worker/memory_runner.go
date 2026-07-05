package worker

import (
	"bufio"
	"bytes"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// MemoryResult holds memory measurement for one compressor on one dataset.
type MemoryResult struct {
	Compressor        string
	Dataset           string
	InputBufferBytes  int64
	PeakMemoryBytes   int64 // total heap+heap-extra+stacks after READY_FOR_COMPRESSION
	CompressorInternal int64 // peak_memory - baseline_peak (or peak - input_buffer if no baseline)
	MemoryUsage       int64 // same as peak_memory_bytes for backward compat
}

// RunMemoryHarness runs the MemoryHarness binary under Valgrind Massif for a single
// compressor on a single .bin file, returning the peak memory after READY_FOR_COMPRESSION
// and the input_buffer_bytes from stdout.
func RunMemoryHarness(binaryPath, compressor, binPath, massifOutPath string, timeout time.Duration) (*MemoryResult, error) {
	cmd := exec.Command("valgrind",
		"--tool=massif",
		"--detailed-freq=1",
		"--max-snapshots=100",
		fmt.Sprintf("--massif-out-file=%s", massifOutPath),
		binaryPath,
		binPath,
		"-c",
		compressor,
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Set LD_LIBRARY_PATH for Squash libraries
	cmd.Env = append(os.Environ(),
		"LD_LIBRARY_PATH="+filepath.Dir(binaryPath)+"/lib",
	)

	// Run with timeout wrapper
	timeoutCmd := exec.Command("timeout",
		fmt.Sprintf("%.0f", timeout.Seconds()),
	)
	timeoutCmd.Args = append(timeoutCmd.Args, cmd.Args...)
	timeoutCmd.Stdout = &stdout
	timeoutCmd.Stderr = &stderr
	timeoutCmd.Env = cmd.Env

	err := timeoutCmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 124 {
				return nil, fmt.Errorf("memory harness timed out after %ds", int(timeout.Seconds()))
			}
		}
		return nil, fmt.Errorf("memory harness exec: %w, stderr: %s", err, truncate(stderr.String(), 500))
	}

	// Parse input_buffer_bytes from stdout
	var inputBuffer int64
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "input_buffer_bytes:") {
			valStr := strings.TrimSpace(strings.TrimPrefix(line, "input_buffer_bytes:"))
			if val, err := strconv.ParseInt(valStr, 10, 64); err == nil {
				inputBuffer = val
			}
		}
	}

	// Extract peak memory from massif.out file
	peakMemory := extractPeakFromMassif(massifOutPath)
	if peakMemory == nil {
		return nil, fmt.Errorf("could not extract peak memory from massif output: %s", massifOutPath)
	}

	// Clean up massif output
	os.Remove(massifOutPath)

	return &MemoryResult{
		Compressor:       compressor,
		InputBufferBytes: inputBuffer,
		PeakMemoryBytes:  *peakMemory,
		MemoryUsage:      *peakMemory,
	}, nil
}

// extractPeakFromMassif parses a Valgrind massif.out file and returns the peak
// total memory (heap + heap-extra + stacks) among snapshots taken after the
// MASSIF_PHASE_MARKER (which corresponds to READY_FOR_COMPRESSION in the harness).
func extractPeakFromMassif(path string) *int64 {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	const markerSubstr = "massif_phase_marker_begin"
	const markerBytesToSubtract = 64 * 1024 // 64 KB for the marker allocation

	var peak *int64
	var curHeap, curExtra, curStacks int64
	var curHeapSet, curHasMarker bool

	commitCurrent := func() {
		if !curHeapSet {
			return
		}
		if !curHasMarker {
			return
		}
		total := curHeap + curExtra + curStacks
		if markerBytesToSubtract > 0 {
			total = max64(0, total-markerBytesToSubtract)
		}
		if peak == nil || total > *peak {
			peak = &total
		}
	}

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "snapshot=") {
			commitCurrent()
			curHeapSet = false
			curExtra = 0
			curStacks = 0
			curHasMarker = false
		} else if strings.Contains(line, markerSubstr) {
			curHasMarker = true
		} else if strings.HasPrefix(line, "mem_heap_B=") {
			if v, err := strconv.ParseInt(strings.TrimPrefix(line, "mem_heap_B="), 10, 64); err == nil {
				curHeap = v
				curHeapSet = true
			}
		} else if strings.HasPrefix(line, "mem_heap_extra_B=") {
			if v, err := strconv.ParseInt(strings.TrimPrefix(line, "mem_heap_extra_B="), 10, 64); err == nil {
				curExtra = v
			}
		} else if strings.HasPrefix(line, "mem_stacks_B=") {
			if v, err := strconv.ParseInt(strings.TrimPrefix(line, "mem_stacks_B="), 10, 64); err == nil {
				curStacks = v
			}
		}
	}
	commitCurrent()

	return peak
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// RunMemoryHarnessWithBaseline runs MemoryHarness for a compressor and its
// corresponding baseline, returning the final memory result with compressor_internal
// computed as (peak - baseline_peak).
func RunMemoryHarnessWithBaseline(binaryPath, compressor, binPath, massifDir string, timeout time.Duration, baselineCache map[string]int64) (*MemoryResult, error) {
	// Determine data format for this compressor (mirrors MemoryHarness logic)
	dataFormat := getDataFormatForCompressor(compressor)

	// Run baseline if not cached
	baselineKey := fmt.Sprintf("%s|%s", binPath, dataFormat)
	if _, ok := baselineCache[baselineKey]; !ok {
		baselineComp := fmt.Sprintf("baseline_%s", dataFormat)
		baselineOut := filepath.Join(massifDir, fmt.Sprintf("massif_baseline_%s.out", dataFormat))
		baseResult, err := RunMemoryHarness(binaryPath, baselineComp, binPath, baselineOut, timeout)
		if err != nil {
			// If baseline fails, fall back to using input_buffer as baseline proxy
			baselineCache[baselineKey] = 0
		} else {
			baselineCache[baselineKey] = baseResult.PeakMemoryBytes
		}
	}

	baselinePeak := baselineCache[baselineKey]

	// Run the actual compressor
	massifOut := filepath.Join(massifDir, fmt.Sprintf("massif_%s.out", sanitizeCompressorName(compressor)))
	result, err := RunMemoryHarness(binaryPath, compressor, binPath, massifOut, timeout)
	if err != nil {
		return nil, err
	}

	// Compute compressor_internal
	if baselinePeak > 0 {
		result.CompressorInternal = max64(0, result.PeakMemoryBytes-baselinePeak)
	} else {
		result.CompressorInternal = max64(0, result.PeakMemoryBytes-result.InputBufferBytes)
	}

	return result, nil
}

// getDataFormatForCompressor mirrors MemoryHarness' input format selection logic.
func getDataFormatForCompressor(compressor string) string {
	c := strings.ToLower(compressor)
	if c == "baseline_shifted" || c == "baseline_double" || c == "baseline_raw" {
		parts := strings.SplitN(c, "_", 2)
		if len(parts) == 2 {
			return parts[1]
		}
	}

	if c == "neats" || c == "dac" || strings.Contains(c, "_gef") || c == "leco" || c == "pfordelta" || strings.HasPrefix(c, "pfordelta_") {
		return "shifted"
	}

	if c == "alp" || c == "gorilla" || c == "chimp" || c == "chimp128" ||
		c == "tsxor" || c == "elf" || c == "camel" || c == "falcon" {
		return "double"
	}

	return "raw"
}

func sanitizeCompressorName(name string) string {
	r := strings.NewReplacer("=", "_eq_", "/", "_", " ", "_")
	return r.Replace(name)
}

// RunAllMemoryMeasurements runs memory measurements for all compressors
// in a benchmark, returning results keyed by compressor name.
func RunAllMemoryMeasurements(binaryPath string, compressors []string, binPaths []string, massifDir string, timeout time.Duration) (map[string]*MemoryResult, error) {
	if err := os.MkdirAll(massifDir, 0755); err != nil {
		return nil, fmt.Errorf("create massif dir: %w", err)
	}

	// We use a simple approach: measure the first .bin file for each compressor.
	// This mirrors the Python script which averages across samples but here we
	// just use the first bin file since multiple samples are for statistical
	// significance in Massif, not for different data.
	if len(binPaths) == 0 {
		return nil, fmt.Errorf("no bin files provided")
	}
	binPath := binPaths[0]

	results := make(map[string]*MemoryResult)
	baselineCache := make(map[string]int64)

	for _, comp := range compressors {
		result, err := RunMemoryHarnessWithBaseline(binaryPath, comp, binPath, massifDir, timeout, baselineCache)
		if err != nil {
			// Log and skip failed compressors
			fmt.Fprintf(os.Stderr, "Memory measurement failed for %s: %v\n", comp, err)
			continue
		}
		// Extract base compressor name (strip =LEVEL suffix)
		baseName := comp
		if eqIdx := strings.IndexByte(comp, '='); eqIdx >= 0 {
			baseName = comp[:eqIdx]
		}
		result.Compressor = baseName
		results[baseName] = result
	}

	// Clean up massif dir
	os.RemoveAll(massifDir)

	if len(results) == 0 {
		return nil, fmt.Errorf("all memory measurements failed")
	}

	return results, nil
}

// UpdateBenchmarkResultsWithMemory updates the benchmark_results table with
// memory metrics from the memory harness measurements.
func UpdateResultWithMemory(result *MemoryResult, inputBuffer, compressorInternal float64) {
	// These are applied to the BenchmarkResult before DB insert
}

// computeInternalMemoryRatio computes internal_memory_ratio = compressor_internal / input_buffer
func computeInternalMemoryRatio(compressorInternal, inputBuffer int64) *float64 {
	if inputBuffer <= 0 {
		return nil
	}
	ratio := float64(compressorInternal) / float64(inputBuffer)
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) {
		return nil
	}
	return &ratio
}

// computeRelativeMemoryUsage computes relative_memory_usage = memory_usage / input_buffer
func computeRelativeMemoryUsage(memoryUsage, inputBuffer int64) *float64 {
	if inputBuffer <= 0 {
		return nil
	}
	ratio := float64(memoryUsage) / float64(inputBuffer)
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) {
		return nil
	}
	return &ratio
}
