package compressor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

const (
	// MaxInstancesPerBenchmark caps how many configured compressors one
	// benchmark may contain.
	MaxInstancesPerBenchmark = 64
	// LabelSeparator joins the compressor name and its brief configuration.
	LabelSeparator = " · "
	// MaxLabelLen matches the benchmark_results.compressor column width.
	MaxLabelLen = 64
)

// Instance is one configured compressor of a benchmark: a built-in algorithm
// or a user package, with a concrete option set and a brief display label.
// Platform/Emulated are only set for user packages and record whether the
// package ran through CPU emulation on the benchmark host.
type Instance struct {
	Name     string                 `json:"name"`
	Options  map[string]interface{} `json:"options"`
	Label    string                 `json:"label"`
	Platform string                 `json:"platform,omitempty"`
	Emulated bool                   `json:"emulated,omitempty"`
}

// nativeOptionKeys are the option keys the native C++ harness understands as
// per-entry options. Other registry options are UI metadata only.
var nativeOptionKeys = map[string]bool{
	"level":         true,
	"max_bpc":       true,
	"lossy":         true,
	"max_precision": true,
	"decimals":      true,
}

// ParseInstances parses the benchmark compressors payload, accepting both the
// current array shape and the legacy {"<name>": {<options>}} map.
func ParseInstances(raw []byte) ([]Instance, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}

	if trimmed[0] == '[' {
		var instances []Instance
		if err := json.Unmarshal(trimmed, &instances); err != nil {
			return nil, fmt.Errorf("parse compressors: %w", err)
		}
		for i := range instances {
			if instances[i].Options == nil {
				instances[i].Options = map[string]interface{}{}
			}
		}
		return instances, nil
	}

	// Legacy map shape: keys are compressor names, values are options.
	var legacy map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &legacy); err != nil {
		return nil, fmt.Errorf("parse compressors: %w", err)
	}
	names := make([]string, 0, len(legacy))
	for name := range legacy {
		names = append(names, name)
	}
	sort.Strings(names)

	instances := make([]Instance, 0, len(names))
	for _, name := range names {
		options := map[string]interface{}{}
		_ = json.Unmarshal(legacy[name], &options)
		instances = append(instances, Instance{Name: name, Options: options, Label: name})
	}
	return instances, nil
}

// MarshalInstances serialises instances for the benchmarks.compressors column.
func MarshalInstances(instances []Instance) ([]byte, error) {
	if instances == nil {
		instances = []Instance{}
	}
	return json.Marshal(instances)
}

// BaseName returns the compressor name without any option suffix.
func BaseName(entry string) string {
	if idx := strings.IndexByte(entry, '='); idx >= 0 {
		return entry[:idx]
	}
	return entry
}

// CanonicalizeOptions validates provided values against an option schema,
// fills defaults for missing keys and drops unknown keys.
func CanonicalizeOptions(schema map[string]Option, provided map[string]interface{}) (map[string]interface{}, error) {
	values := make(map[string]interface{}, len(schema))
	for name, opt := range schema {
		raw, ok := provided[name]
		if !ok || raw == nil {
			values[name] = opt.Default
			continue
		}
		value, err := coerceOption(name, opt, raw)
		if err != nil {
			return nil, err
		}
		values[name] = value
	}
	return values, nil
}

func coerceOption(name string, opt Option, raw interface{}) (interface{}, error) {
	switch opt.Type {
	case "number":
		var f float64
		switch v := raw.(type) {
		case float64:
			f = v
		case float32:
			f = float64(v)
		case int:
			f = float64(v)
		case int64:
			f = float64(v)
		case json.Number:
			parsed, err := v.Float64()
			if err != nil {
				return nil, fmt.Errorf("option %q must be a number", name)
			}
			f = parsed
		default:
			return nil, fmt.Errorf("option %q must be a number", name)
		}
		if f != math.Trunc(f) {
			return nil, fmt.Errorf("option %q must be an integer", name)
		}
		value := int(f)
		if opt.Min != nil && value < *opt.Min {
			return nil, fmt.Errorf("option %q must be at least %d", name, *opt.Min)
		}
		if opt.Max != nil && value > *opt.Max {
			return nil, fmt.Errorf("option %q must be at most %d", name, *opt.Max)
		}
		return value, nil
	case "boolean":
		value, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("option %q must be true or false", name)
		}
		return value, nil
	case "select":
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("option %q must be a string", name)
		}
		for _, candidate := range opt.Options {
			if candidate == value {
				return value, nil
			}
		}
		return nil, fmt.Errorf("option %q has an unsupported value %q", name, value)
	default:
		return nil, fmt.Errorf("option %q has an unsupported type %q", name, opt.Type)
	}
}

// BuildLabel renders the brief configuration label shown beside the
// compressor name (e.g. "gzip · level 9"); only non-default options appear.
func BuildLabel(name string, schema map[string]Option, values map[string]interface{}) string {
	names := make([]string, 0, len(schema))
	for optionName := range schema {
		names = append(names, optionName)
	}
	sort.Strings(names)

	parts := make([]string, 0, len(names))
	for _, optionName := range names {
		opt := schema[optionName]
		value, ok := values[optionName]
		if !ok || value == opt.Default {
			continue
		}
		switch v := value.(type) {
		case bool:
			if v {
				parts = append(parts, optionName)
			} else {
				parts = append(parts, optionName+" off")
			}
		default:
			parts = append(parts, fmt.Sprintf("%s %v", optionName, value))
		}
	}

	label := name
	if len(parts) > 0 {
		label += LabelSeparator + strings.Join(parts, LabelSeparator)
	}
	return truncateLabel(label)
}

// BuildInvocation renders the native `-c` entry for a built-in instance, e.g.
// "gzip=level:9" or "neats=max_bpc:16;lossy:true". Non-default options that the
// native harness does not understand are ignored.
func BuildInvocation(name string, schema map[string]Option, values map[string]interface{}) string {
	base := name
	if name == "pfordelta" {
		if codec, ok := values["codec"].(string); ok && codec != "" && codec != "simdnewpfor" {
			base = "pfordelta_" + codec
		}
	}

	names := make([]string, 0, len(schema))
	for optionName := range schema {
		names = append(names, optionName)
	}
	sort.Strings(names)

	parts := make([]string, 0, len(names))
	for _, optionName := range names {
		if !nativeOptionKeys[optionName] {
			continue
		}
		value, ok := values[optionName]
		if !ok || value == schema[optionName].Default {
			continue
		}
		parts = append(parts, optionName+":"+formatOptionValue(value))
	}
	if len(parts) == 0 {
		return base
	}
	return base + "=" + strings.Join(parts, ";")
}

func formatOptionValue(value interface{}) string {
	switch v := value.(type) {
	case bool:
		return strconv.FormatBool(v)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return fmt.Sprint(v)
	}
}

func truncateLabel(label string) string {
	if len(label) <= MaxLabelLen {
		return label
	}
	return label[:MaxLabelLen]
}

// WithUniqueLabel appends a numeric suffix when the label is already taken.
func WithUniqueLabel(label string, taken map[string]bool) string {
	if !taken[label] {
		taken[label] = true
		return label
	}
	for i := 2; ; i++ {
		suffix := fmt.Sprintf(" #%d", i)
		base := label
		if len(base)+len(suffix) > MaxLabelLen {
			base = base[:MaxLabelLen-len(suffix)]
		}
		candidate := base + suffix
		if !taken[candidate] {
			taken[candidate] = true
			return candidate
		}
	}
}
