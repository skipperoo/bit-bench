package model

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// ChartShapes are the marker shapes the frontend can draw
// (frontend/src/components/charts/CompressorMarker.tsx).
var ChartShapes = []string{
	"circle", "square", "diamond", "triangle-up", "triangle-down",
	"star", "pentagon", "hexagon", "x", "cross",
}

// MaxChartShapeOverrides caps the per-user override map.
const MaxChartShapeOverrides = 500

// ValidateChartShapes checks a per-user map of compressor label → shape.
func ValidateChartShapes(shapes map[string]string) error {
	if len(shapes) > MaxChartShapeOverrides {
		return fmt.Errorf("at most %d shape overrides are allowed", MaxChartShapeOverrides)
	}
	for name, shape := range shapes {
		if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 64 {
			return fmt.Errorf("compressor name %q must be 1-64 characters", name)
		}
		if !isChartShape(shape) {
			return fmt.Errorf("unknown shape %q for %s (allowed: %s)", shape, name, strings.Join(ChartShapes, ", "))
		}
	}
	return nil
}

func isChartShape(shape string) bool {
	for _, s := range ChartShapes {
		if s == shape {
			return true
		}
	}
	return false
}
