package compressor

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// PackageSpec is the parsed spec.yaml of a user-uploaded compressor package.
type PackageSpec struct {
	Name        string            `yaml:"name" json:"name"`
	Version     string            `yaml:"version" json:"version"`
	Description string            `yaml:"description" json:"description"`
	Language    string            `yaml:"language" json:"language"`
	Entrypoint  string            `yaml:"entrypoint" json:"entrypoint"`
	Workers     int               `yaml:"workers" json:"workers"`
	Build       *PackageBuildSpec `yaml:"build" json:"build,omitempty"`
	Options     map[string]Option `yaml:"options" json:"options"`
}

// PackageBuildSpec describes the optional offline build step of a package.
type PackageBuildSpec struct {
	Command        string `yaml:"command" json:"command"`
	TimeoutSeconds int    `yaml:"timeout_seconds" json:"timeout_seconds"`
}

var (
	packageNameRe = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
	optionNameRe  = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
)

// ParseSpec parses and validates a spec.yaml document.
func ParseSpec(data []byte) (*PackageSpec, error) {
	var spec PackageSpec
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&spec); err != nil {
		return nil, fmt.Errorf("parse spec.yaml: %w", err)
	}

	if spec.Workers == 0 {
		spec.Workers = 1
	}
	if spec.Options == nil {
		spec.Options = map[string]Option{}
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	return &spec, nil
}

// Validate checks the structural rules of a package spec.
func (s *PackageSpec) Validate() error {
	if !packageNameRe.MatchString(s.Name) {
		return fmt.Errorf("invalid package name %q: must match [a-z0-9_]{1,64}", s.Name)
	}
	if IsValid(s.Name) {
		return fmt.Errorf("package name %q collides with a built-in compressor", s.Name)
	}

	s.Version = strings.TrimSpace(s.Version)
	if s.Version == "" {
		return fmt.Errorf("version is required")
	}
	if len(s.Version) > 32 {
		return fmt.Errorf("version must be at most 32 characters")
	}

	s.Entrypoint = strings.TrimSpace(s.Entrypoint)
	if s.Entrypoint == "" {
		return fmt.Errorf("entrypoint is required")
	}
	if len(strings.Fields(s.Entrypoint)) == 0 {
		return fmt.Errorf("entrypoint is empty")
	}
	for _, token := range strings.Fields(s.Entrypoint) {
		if strings.Contains(token, "..") {
			return fmt.Errorf("entrypoint must not contain parent directory references")
		}
	}

	if s.Workers < 1 {
		return fmt.Errorf("workers must be at least 1")
	}
	if s.Build != nil && s.Build.TimeoutSeconds < 0 {
		return fmt.Errorf("build.timeout_seconds must not be negative")
	}

	for name, opt := range s.Options {
		if err := validateOption(name, opt); err != nil {
			return err
		}
	}
	return nil
}

// OptionNames returns the sorted option names of the spec.
func (s *PackageSpec) OptionNames() []string {
	names := make([]string, 0, len(s.Options))
	for name := range s.Options {
		names = append(names, name)
	}
	return names
}

func validateOption(name string, opt Option) error {
	if !optionNameRe.MatchString(name) {
		return fmt.Errorf("invalid option name %q: must match [a-z0-9_]{1,32}", name)
	}

	switch opt.Type {
	case "number":
		if opt.Min == nil || opt.Max == nil {
			return fmt.Errorf("option %q: number requires min and max", name)
		}
		if *opt.Min > *opt.Max {
			return fmt.Errorf("option %q: min must not exceed max", name)
		}
		if opt.Step != nil && *opt.Step <= 0 {
			return fmt.Errorf("option %q: step must be positive", name)
		}
		if !isNumeric(opt.Default) {
			return fmt.Errorf("option %q: number default must be numeric", name)
		}
		if !withinBounds(opt.Default, *opt.Min, *opt.Max) {
			return fmt.Errorf("option %q: default %v outside [%d, %d]", name, opt.Default, *opt.Min, *opt.Max)
		}
	case "boolean":
		if _, ok := opt.Default.(bool); !ok {
			return fmt.Errorf("option %q: boolean default must be true or false", name)
		}
	case "select":
		if len(opt.Options) == 0 {
			return fmt.Errorf("option %q: select requires options", name)
		}
		def, ok := opt.Default.(string)
		if !ok {
			return fmt.Errorf("option %q: select default must be a string", name)
		}
		found := false
		for _, candidate := range opt.Options {
			if candidate == def {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("option %q: default %q is not one of the allowed options", name, def)
		}
	default:
		return fmt.Errorf("option %q: unsupported type %q", name, opt.Type)
	}
	return nil
}

func isNumeric(v any) bool {
	switch v.(type) {
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return true
	}
	return false
}

func numericValue(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case float64:
		return n
	case float32:
		return float64(n)
	default:
		return 0
	}
}

func withinBounds(v any, min, max int) bool {
	f := numericValue(v)
	return f >= float64(min) && f <= float64(max)
}
