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
	cmd.Env = append(os.Environ(),
		"LD_LIBRARY_PATH="+filepath.Dir(binaryPath)+"/lib",
	)

	var err error
	if onCompressorStart != nil {
		// Read stderr line by line to report progress. All reads must finish
		// before Wait, which closes the pipe.
		stderrPipe, pipeErr := cmd.StderrPipe()
		if pipeErr != nil {
			return nil, fmt.Errorf("stderr pipe: %w", pipeErr)
		}
		if err := cmd.Start(); err != nil {
			return nil, fmt.Errorf("run benchmark: %w", err)
		}
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
		err = cmd.Wait()
	} else {
		cmd.Stderr = &stderr
		err = cmd.Run()
	}

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
