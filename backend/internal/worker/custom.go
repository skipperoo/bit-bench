package worker

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"bitbench/internal/compressor"
	"bitbench/internal/runner"
)

// mergeOptions starts from the spec defaults and overlays the user-selected
// values. Unknown keys are ignored.
func mergeOptions(defaults map[string]compressor.Option, provided map[string]interface{}) map[string]interface{} {
	merged := make(map[string]interface{}, len(defaults))
	for name, opt := range defaults {
		merged[name] = opt.Default
	}
	for name, value := range provided {
		if _, known := defaults[name]; known {
			merged[name] = value
		}
	}
	return merged
}

// buildCustomCommand renders the invocation contract:
//
//	<entrypoint> -o <out.csv> --<option>=<value>... --options <options.json> <input.bin>
func buildCustomCommand(entrypoint string, options map[string]interface{}, outPath, optionsPath, binPath string) string {
	parts := []string{entrypoint, "-o", shellQuote(outPath)}

	names := make([]string, 0, len(options))
	for name := range options {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		parts = append(parts, shellQuote(fmt.Sprintf("--%s=%s", name, formatOptionValue(options[name]))))
	}

	parts = append(parts, "--options", shellQuote(optionsPath), shellQuote(binPath))
	return strings.Join(parts, " ")
}

func formatOptionValue(value interface{}) string {
	switch v := value.(type) {
	case bool:
		return strconv.FormatBool(v)
	case string:
		return v
	case float64:
		if v == math.Trunc(v) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return fmt.Sprint(value)
	}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func marshalOptions(options map[string]interface{}) ([]byte, error) {
	return json.MarshalIndent(options, "", "  ")
}

// volumeOrBind builds a mount that prefers a Docker named volume and falls
// back to a bind mount (for local runs outside compose).
func volumeOrBind(path, volume string, readOnly bool) runner.Mount {
	if volume != "" {
		return runner.Mount{Type: "volume", Source: volume, Target: path, ReadOnly: readOnly}
	}
	return runner.Mount{Type: "bind", Source: path, Target: path, ReadOnly: readOnly}
}
