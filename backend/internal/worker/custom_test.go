package worker

import (
	"reflect"
	"strings"
	"testing"

	"bitbench/internal/compressor"
)

func TestMergeOptions(t *testing.T) {
	defaults := map[string]compressor.Option{
		"block_size": {Type: "number", Default: 6},
		"mode":       {Type: "select", Default: "fast"},
	}
	provided := map[string]interface{}{
		"block_size": float64(9),
		"unknown":    "ignored",
	}

	merged := mergeOptions(defaults, provided)
	if merged["block_size"] != float64(9) {
		t.Errorf("block_size = %v, want 9", merged["block_size"])
	}
	if merged["mode"] != "fast" {
		t.Errorf("mode = %v, want default fast", merged["mode"])
	}
	if _, ok := merged["unknown"]; ok {
		t.Error("unknown option should be ignored")
	}
}

func TestFormatOptionValue(t *testing.T) {
	tests := []struct {
		in   interface{}
		want string
	}{
		{true, "true"},
		{false, "false"},
		{"optimal", "optimal"},
		{float64(6), "6"},
		{float64(6.5), "6.5"},
		{3, "3"},
		{int64(4), "4"},
	}
	for _, tt := range tests {
		if got := formatOptionValue(tt.in); got != tt.want {
			t.Errorf("formatOptionValue(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestBuildCustomCommand(t *testing.T) {
	options := map[string]interface{}{
		"mode":       "fast lane",
		"block_size": float64(9),
	}
	command := buildCustomCommand("python3 src/main.py", options, "/data/out.csv", "/data/opts.json", "/data/in.bin")

	if !strings.HasPrefix(command, "python3 src/main.py -o '/data/out.csv'") {
		t.Errorf("unexpected prefix: %s", command)
	}
	if !strings.Contains(command, "--block_size=9") {
		t.Errorf("missing numeric option: %s", command)
	}
	if !strings.Contains(command, `'--mode=fast lane'`) {
		t.Errorf("option value with space should be quoted: %s", command)
	}
	if !strings.Contains(command, "--options '/data/opts.json' '/data/in.bin'") {
		t.Errorf("missing json/input args: %s", command)
	}
}

func TestShellQuote(t *testing.T) {
	if got := shellQuote("it's"); !reflect.DeepEqual(got, `'it'\''s'`) {
		t.Errorf("shellQuote = %q", got)
	}
}
