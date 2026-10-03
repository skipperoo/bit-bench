package compressor

import (
	"strings"
	"testing"
)

func validSpecYAML() string {
	return `
name: my_codec
version: 1.2.0
description: test codec
language: cpp
entrypoint: ./build/my_codec
workers: 2
build:
  command: make -j2
  timeout_seconds: 120
options:
  block_size:
    type: number
    min: 1
    max: 9
    default: 6
    step: 1
  mode:
    type: select
    options: [fast, optimal]
    default: fast
  enabled:
    type: boolean
    default: true
`
}

func TestParseSpecValid(t *testing.T) {
	spec, err := ParseSpec([]byte(validSpecYAML()))
	if err != nil {
		t.Fatalf("ParseSpec: %v", err)
	}
	if spec.Name != "my_codec" || spec.Workers != 2 || spec.Entrypoint != "./build/my_codec" {
		t.Errorf("unexpected spec: %+v", spec)
	}
	if spec.Build == nil || spec.Build.Command != "make -j2" || spec.Build.TimeoutSeconds != 120 {
		t.Errorf("unexpected build spec: %+v", spec.Build)
	}
	if len(spec.Options) != 3 {
		t.Errorf("options = %d, want 3", len(spec.Options))
	}
	if spec.Options["block_size"].Type != "number" {
		t.Errorf("block_size type = %q", spec.Options["block_size"].Type)
	}
}

func TestParseSpecDefaults(t *testing.T) {
	spec, err := ParseSpec([]byte("name: tiny\nversion: \"1\"\nentrypoint: python3 src/main.py\n"))
	if err != nil {
		t.Fatalf("ParseSpec: %v", err)
	}
	if spec.Workers != 1 {
		t.Errorf("workers = %d, want default 1", spec.Workers)
	}
	if spec.Options == nil {
		t.Error("options should default to an empty map, not nil")
	}
}

func TestParseSpecInvalid(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want string
	}{
		{"bad name", "name: My Codec\nversion: 1\nentrypoint: ./run\n", "invalid package name"},
		{"builtin collision", "name: gzip\nversion: 1\nentrypoint: ./run\n", "collides with a built-in"},
		{"missing version", "name: codec\nentrypoint: ./run\n", "version is required"},
		{"missing entrypoint", "name: codec\nversion: 1\n", "entrypoint is required"},
		{"traversal entrypoint", "name: codec\nversion: 1\nentrypoint: ../run\n", "parent directory"},
		{"unknown field", "name: codec\nversion: 1\nentrypoint: ./run\nextra: true\n", "field extra not found"},
		{"number missing bounds", "name: codec\nversion: 1\nentrypoint: ./run\noptions:\n  size:\n    type: number\n    default: 1\n", "requires min and max"},
		{"number default out of bounds", "name: codec\nversion: 1\nentrypoint: ./run\noptions:\n  size:\n    type: number\n    min: 1\n    max: 3\n    default: 9\n", "outside"},
		{"boolean wrong default", "name: codec\nversion: 1\nentrypoint: ./run\noptions:\n  on:\n    type: boolean\n    default: 1\n", "boolean default"},
		{"select bad default", "name: codec\nversion: 1\nentrypoint: ./run\noptions:\n  mode:\n    type: select\n    options: [a, b]\n    default: c\n", "not one of the allowed"},
		{"unknown type", "name: codec\nversion: 1\nentrypoint: ./run\noptions:\n  x:\n    type: string\n    default: hi\n", "unsupported type"},
		{"invalid option name", "name: codec\nversion: 1\nentrypoint: ./run\noptions:\n  BadName:\n    type: boolean\n    default: true\n", "invalid option name"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseSpec([]byte(tt.yaml))
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %q, want containing %q", err, tt.want)
			}
		})
	}
}
