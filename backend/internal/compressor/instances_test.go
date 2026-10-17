package compressor

import (
	"encoding/json"
	"testing"
)

func TestCanonicalizeOptions(t *testing.T) {
	schema := map[string]Option{
		"level":  {Type: "number", Min: intPtr(1), Max: intPtr(9), Default: 6, Step: intPtr(1)},
		"lossy":  {Type: "boolean", Default: false},
		"codec":  {Type: "select", Options: []string{"a", "b"}, Default: "a"},
		"unused": {Type: "number", Min: intPtr(0), Max: intPtr(1), Default: 0},
	}

	values, err := CanonicalizeOptions(schema, map[string]interface{}{
		"level":   float64(9),
		"lossy":   true,
		"codec":   "b",
		"unknown": "dropped",
	})
	if err != nil {
		t.Fatalf("CanonicalizeOptions: %v", err)
	}
	if values["level"] != 9 || values["lossy"] != true || values["codec"] != "b" {
		t.Errorf("unexpected values: %v", values)
	}
	if values["unused"] != 0 {
		t.Errorf("default not filled: %v", values)
	}
	if _, ok := values["unknown"]; ok {
		t.Error("unknown option should be dropped")
	}
}

func TestCanonicalizeOptionsRejectsInvalid(t *testing.T) {
	schema := map[string]Option{
		"level": {Type: "number", Min: intPtr(1), Max: intPtr(9), Default: 6},
		"codec": {Type: "select", Options: []string{"a", "b"}, Default: "a"},
		"lossy": {Type: "boolean", Default: false},
	}
	tests := []struct {
		name string
		in   map[string]interface{}
	}{
		{"out of range", map[string]interface{}{"level": float64(99)}},
		{"not integral", map[string]interface{}{"level": 3.5}},
		{"wrong type", map[string]interface{}{"level": "high"}},
		{"bad select", map[string]interface{}{"codec": "c"}},
		{"bad boolean", map[string]interface{}{"lossy": "yes"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := CanonicalizeOptions(schema, tt.in); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestBuildLabel(t *testing.T) {
	schema := map[string]Option{
		"level": {Type: "number", Min: intPtr(1), Max: intPtr(9), Default: 6},
		"lossy": {Type: "boolean", Default: false},
	}
	if got := BuildLabel("gzip", schema, map[string]interface{}{"level": 9, "lossy": false}); got != "gzip · level 9" {
		t.Errorf("label = %q", got)
	}
	if got := BuildLabel("neats", schema, map[string]interface{}{"level": 6, "lossy": true}); got != "neats · lossy" {
		t.Errorf("label = %q", got)
	}
	if got := BuildLabel("gorilla", map[string]Option{}, map[string]interface{}{}); got != "gorilla" {
		t.Errorf("label = %q", got)
	}
}

func TestBuildInvocation(t *testing.T) {
	schema := Registry["gzip"]
	if got := BuildInvocation("gzip", schema, map[string]interface{}{"level": 9}); got != "gzip=level:9" {
		t.Errorf("invocation = %q", got)
	}
	if got := BuildInvocation("gzip", schema, map[string]interface{}{"level": 6}); got != "gzip" {
		t.Errorf("default invocation = %q", got)
	}

	neats := Registry["neats"]
	got := BuildInvocation("neats", neats, map[string]interface{}{"max_bpc": 16, "lossy": true})
	if got != "neats=lossy:true;max_bpc:16" {
		t.Errorf("neats invocation = %q", got)
	}

	pfor := Registry["pfordelta"]
	if got := BuildInvocation("pfordelta", pfor, map[string]interface{}{"codec": "pfor"}); got != "pfordelta_pfor" {
		t.Errorf("pfordelta invocation = %q", got)
	}
	if got := BuildInvocation("pfordelta", pfor, map[string]interface{}{"codec": "simdnewpfor"}); got != "pfordelta" {
		t.Errorf("pfordelta default invocation = %q", got)
	}
}

func TestParseInstancesArray(t *testing.T) {
	raw := []byte(`[{"name":"gzip","options":{"level":9},"label":"gzip · level 9"}]`)
	instances, err := ParseInstances(raw)
	if err != nil {
		t.Fatalf("ParseInstances: %v", err)
	}
	if len(instances) != 1 || instances[0].Name != "gzip" || instances[0].Label != "gzip · level 9" {
		t.Errorf("instances = %+v", instances)
	}
}

func TestParseInstancesLegacyMap(t *testing.T) {
	raw := []byte(`{"gzip":{"level":9},"gorilla":{}}`)
	instances, err := ParseInstances(raw)
	if err != nil {
		t.Fatalf("ParseInstances: %v", err)
	}
	if len(instances) != 2 {
		t.Fatalf("instances = %d", len(instances))
	}
	if instances[0].Name != "gorilla" || instances[1].Name != "gzip" {
		t.Errorf("sorted names expected, got %+v", instances)
	}
	if instances[1].Label != "gzip" {
		t.Errorf("legacy label = %q", instances[1].Label)
	}
}

func TestMarshalInstances(t *testing.T) {
	raw, err := MarshalInstances([]Instance{{Name: "gzip", Options: map[string]interface{}{"level": 9}, Label: "gzip · level 9"}})
	if err != nil {
		t.Fatalf("MarshalInstances: %v", err)
	}
	var parsed []Instance
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("roundtrip: %v", err)
	}
	if parsed[0].Options["level"] != float64(9) {
		t.Errorf("roundtrip options = %v", parsed[0].Options)
	}
}

func TestBaseName(t *testing.T) {
	if got := BaseName("gzip=level:9"); got != "gzip" {
		t.Errorf("BaseName = %q", got)
	}
	if got := BaseName("gzip"); got != "gzip" {
		t.Errorf("BaseName = %q", got)
	}
}

func TestWithUniqueLabel(t *testing.T) {
	taken := map[string]bool{"gzip · level 9": true}
	if got := WithUniqueLabel("gzip · level 9", taken); got != "gzip · level 9 #2" {
		t.Errorf("unique label = %q", got)
	}
	if got := WithUniqueLabel("gzip · level 1", taken); got != "gzip · level 1" {
		t.Errorf("unique label = %q", got)
	}
}
