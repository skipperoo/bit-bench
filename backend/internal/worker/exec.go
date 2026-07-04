package worker

import (
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
func mapCompressorName(name string, options map[string]interface{}) string {
	if name == "pfordelta" {
		if codec, ok := options["codec"]; ok {
			codecStr, ok := codec.(string)
			if ok && codecStr != "" && codecStr != "simdnewpfor" {
				return "pfordelta_" + codecStr
			}
		}
	}
	return name
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

// RunBenchmark executes the benchmark binary against a single .bin file.
func RunBenchmark(binaryPath, compressorList, binPath, outDir string, timeout time.Duration) (*ExecResult, error) {
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
	cmd.Stderr = &stderr
	cmd.Env = append(os.Environ(),
		"LD_LIBRARY_PATH="+filepath.Dir(binaryPath)+"/lib",
	)

	err := cmd.Run()
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
