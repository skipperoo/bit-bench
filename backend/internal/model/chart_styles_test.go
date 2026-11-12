package model

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidateChartShapes(t *testing.T) {
	if err := ValidateChartShapes(map[string]string{}); err != nil {
		t.Errorf("empty map: %v", err)
	}
	if err := ValidateChartShapes(map[string]string{"Gorilla": "hexagon", "gzip · level 9": "x"}); err != nil {
		t.Errorf("valid map: %v", err)
	}
	bad := []map[string]string{
		{"Gorilla": "blob"},
		{"": "circle"},
		{"  ": "circle"},
		{strings.Repeat("a", 65): "circle"},
	}
	for _, m := range bad {
		if err := ValidateChartShapes(m); err == nil {
			t.Errorf("%v accepted", m)
		}
	}
	tooMany := map[string]string{}
	for i := 0; i <= MaxChartShapeOverrides; i++ {
		tooMany[fmt.Sprintf("c%d", i)] = "circle"
	}
	if err := ValidateChartShapes(tooMany); err == nil {
		t.Error("over the cap accepted")
	}
}

func TestValidateChartStyles(t *testing.T) {
	s := &ChartStyles{Colors: map[string]string{"Gorilla": "#1F77B4"}}
	if err := ValidateChartStyles(s); err != nil {
		t.Fatalf("valid styles: %v", err)
	}
	if s.Shapes == nil || s.Colors["Gorilla"] != "#1f77b4" {
		t.Errorf("not normalized: %+v", s)
	}
	for _, c := range []string{"red", "#1f77b", "#1f77b4ff", "1f77b4", "#zzzzzz"} {
		if err := ValidateChartStyles(&ChartStyles{Colors: map[string]string{"gzip": c}}); err == nil {
			t.Errorf("colour %q accepted", c)
		}
	}
	if err := ValidateChartStyles(&ChartStyles{Colors: map[string]string{"": "#000000"}}); err == nil {
		t.Error("empty name accepted")
	}
	if err := ValidateChartStyles(&ChartStyles{Shapes: map[string]string{"gzip": "blob"}}); err == nil {
		t.Error("bad shape accepted")
	}
}
