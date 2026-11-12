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
