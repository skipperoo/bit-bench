package model

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ChartStyles are a user's chart overrides, keyed by compressor label:
// marker shape and colour. Labels without an entry use the shared defaults.
type ChartStyles struct {
	Shapes map[string]string `json:"shapes"`
	Colors map[string]string `json:"colors"`
}

// ChartShapes are the marker shapes the frontend can draw
// (frontend/src/components/charts/CompressorMarker.tsx).
var ChartShapes = []string{
	"circle", "square", "diamond", "triangle-up", "triangle-down",
	"star", "pentagon", "hexagon", "x", "cross",
}

// MaxChartShapeOverrides caps each per-user override map.
const MaxChartShapeOverrides = 500

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// ValidateChartStyles validates both override maps and lower-cases colours.
func ValidateChartStyles(s *ChartStyles) error {
	if s.Shapes == nil {
		s.Shapes = map[string]string{}
	}
	if s.Colors == nil {
		s.Colors = map[string]string{}
	}
	if err := ValidateChartShapes(s.Shapes); err != nil {
		return err
	}
	return ValidateChartColors(s.Colors)
}

// ValidateChartColors checks a per-user map of compressor label → #rrggbb and
// lower-cases the colours.
func ValidateChartColors(colors map[string]string) error {
	if len(colors) > MaxChartShapeOverrides {
		return fmt.Errorf("at most %d colour overrides are allowed", MaxChartShapeOverrides)
	}
	for name, color := range colors {
		if err := validateLabel(name); err != nil {
			return err
		}
		if !hexColor.MatchString(color) {
			return fmt.Errorf("colour %q for %s must be #rrggbb", color, name)
		}
		colors[name] = strings.ToLower(color)
	}
	return nil
}

func validateLabel(name string) error {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 64 {
		return fmt.Errorf("compressor name %q must be 1-64 characters", name)
	}
	return nil
}

// ValidateChartShapes checks a per-user map of compressor label → shape.
func ValidateChartShapes(shapes map[string]string) error {
	if len(shapes) > MaxChartShapeOverrides {
		return fmt.Errorf("at most %d shape overrides are allowed", MaxChartShapeOverrides)
	}
	for name, shape := range shapes {
		if err := validateLabel(name); err != nil {
			return err
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
