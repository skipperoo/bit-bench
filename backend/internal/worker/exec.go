package worker

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ExecResult holds the outcome of running the benchmark binary.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	CSVPath  string
}

// mapCompressorName transforms compressor + options into the binary-compatible name.
// If the compressor has a "level" option and a non-default value, appends =LEVEL.
func mapCompressorName(name string, options map[string]interface{}) string {
	base := name
	if name == "pfordelta" {
		if codec, ok := options["codec"]; ok {
			codecStr, ok := codec.(string)
			if ok && codecStr != "" && codecStr != "simdnewpfor" {
				base = "pfordelta_" + codecStr
			}
		}
	}
	// Append =LEVEL for compressors with a level option
	if levelVal, ok := options["level"]; ok {
		if level, ok := levelVal.(float64); ok && level != 6 {
			return fmt.Sprintf("%s=%d", base, int(level))
		}
	}
	return base
}

// BuildCompressorList converts the compressors map into a comma-separated list
// of binary-compatible compressor names.
func BuildCompressorList(compressors map[string]interface{}) string {
	var names []string
	for name, opts := range compressors {
		optMap, _ := opts.(map[string]interface{})
		names = append(names, mapCompressorName(name, optMap))
	}
	return strings.Join(names, ",")
}

// ProgressCallback is called for each compressor as it starts running.
type ProgressCallback func(compressorName string)

// RunBenchmark executes the benchmark binary against a single .bin file.
// onCompressorStart is called for each compressor as it begins (from stderr output).
func RunBenchmark(binaryPath, compressorList, binPath, outDir string, timeout time.Duration, onCompressorStart ProgressCallback) (*ExecResult, error) {
	outPath := filepath.Join(outDir, "out.csv")

	cmd := exec.Command("timeout",
		fmt.Sprintf("%.0f", timeout.Seconds()),
		binaryPath,
		"-c", compressorList,
		"-o", outPath,
		binPath,
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout

	if onCompressorStart != nil {
		stderrPipe, err := cmd.StderrPipe()
		if err == nil {
			go func() {
				scanner := bufio.NewScanner(stderrPipe)
				for scanner.Scan() {
					line := scanner.Text()
					stderr.WriteString(line + "\n")
					if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "Running ") {
						comp := strings.TrimSuffix(strings.TrimPrefix(trimmed, "Running "), "...")
						comp = strings.TrimSpace(strings.SplitN(comp, " ", 2)[0])
						onCompressorStart(comp)
					}
				}
			}()
		} else {
			cmd.Stderr = &stderr
		}
	} else {
		cmd.Stderr = &stderr
	}
	cmd.Env = append(os.Environ(),
		"LD_LIBRARY_PATH="+filepath.Dir(binaryPath)+"/lib",
	)

	err := cmd.Run()
	// Ensure stderr from the goroutine is fully written
	time.Sleep(50 * time.Millisecond)

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("run benchmark: %w", err)
		}
	}

	// Check if CSV was produced
	if _, statErr := os.Stat(outPath); statErr != nil {
		return &ExecResult{
			ExitCode: exitCode,
			Stdout:   stdout.String(),
			Stderr:   stderr.String(),
		}, nil
	}

	return &ExecResult{
		ExitCode: exitCode,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		CSVPath:  outPath,
	}, nil
}
