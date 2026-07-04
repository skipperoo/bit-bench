package compressor

type Option struct {
	Type    string   `json:"type"`
	Min     *int     `json:"min,omitempty"`
	Max     *int     `json:"max,omitempty"`
	Default any      `json:"default"`
	Step    *int     `json:"step,omitempty"`
	Options []string `json:"options,omitempty"`
}

var Registry = map[string]map[string]Option{
	"neats": {
		"max_bpc": {Type: "number", Min: intPtr(0), Max: intPtr(64), Default: 32, Step: intPtr(1)},
		"lossy":   {Type: "boolean", Default: false},
	},
	"dac":                  {},
	"rle_gef":              {},
	"u_gef_approximate":    {},
	"u_gef_optimal":        {},
	"b_gef_approximate":    {},
	"b_gef_optimal":        {},
	"b_star_gef_approximate": {},
	"b_star_gef_optimal":   {},
	"gorilla":              {},
	"chimp":                {},
	"chimp128":             {},
	"tsxor":                {},
	"elf":                  {},
	"camel": {
		"max_precision": {Type: "number", Min: intPtr(0), Max: intPtr(18), Default: 18, Step: intPtr(1)},
	},
	"falcon": {
		"decimals": {Type: "number", Min: intPtr(-1), Max: intPtr(18), Default: -1, Step: intPtr(1)},
	},
	"alp":       {},
	"pfordelta": {
		"codec": {Type: "select", Options: []string{"simdnewpfor", "simdpfor", "pfor", "optpfor", "vbp", "varint"}, Default: "simdnewpfor"},
	},
	"gzip_1": {
		"level": {Type: "number", Min: intPtr(1), Max: intPtr(1), Default: 1, Step: intPtr(1)},
	},
	"gzip_6": {
		"level": {Type: "number", Min: intPtr(6), Max: intPtr(6), Default: 6, Step: intPtr(1)},
	},
	"gzip_9": {
		"level": {Type: "number", Min: intPtr(9), Max: intPtr(9), Default: 9, Step: intPtr(1)},
	},
	"bzip3": {},
}

func intPtr(i int) *int {
	return &i
}
