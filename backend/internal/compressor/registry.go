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
	// === Time Series (constructors take no tunable params) ===
	"gorilla":  {},
	"chimp":    {},
	"chimp128": {},
	"tsxor":    {},
	"elf":      {},
	"alp":      {},

	// === NeaTS: piecewise-optimal approximation ===
	// max_bpc controls bits per correction value; lossy enables lossy mode
	"neats": {
		"max_bpc": {Type: "number", Min: intPtr(0), Max: intPtr(64), Default: 32, Step: intPtr(1)},
		"lossy":   {Type: "boolean", Default: false},
	},

	// === Camel: erasing-based float compressor ===
	// max_precision controls how many decimal digits to retain
	"camel": {
		"max_precision": {Type: "number", Min: intPtr(0), Max: intPtr(18), Default: 18, Step: intPtr(1)},
	},

	// === Falcon: block-based float compressor ===
	// decimals forces decimal digit count (-1 = auto-detect)
	"falcon": {
		"decimals": {Type: "number", Min: intPtr(-1), Max: intPtr(18), Default: -1, Step: intPtr(1)},
	},

	// === PForDelta: FastPFOR codec selector ===
	// codec selects the underlying FastPFOR implementation
	"pfordelta": {
		"codec": {Type: "select",
			Options: []string{
				"simdnewpfor", "simdpfor", "newpfor", "pfor",
				"optpfor", "simdoptpfor", "simple8b", "simple16",
				"varint", "streamvbyte", "maskedvbyte",
			},
			Default: "simdnewpfor",
		},
	},

	// === GZip: level encoded in name (gzip_1 → level 1) ===
	// No tunable options — each variant is a fixed level
	"gzip_1": {},
	"gzip_6": {},
	"gzip_9": {},

	// === Generic Elias-Fano (GEF) family ===
	// All params are compile-time templates; no runtime options
	"dac":                    {},
	"rle_gef":                {},
	"u_gef_approximate":      {},
	"u_gef_optimal":          {},
	"b_gef_approximate":      {},
	"b_gef_optimal":          {},
	"b_star_gef_approximate": {},
	"b_star_gef_optimal":     {},

	// === bzip3: block size derived from benchmark block_size ===
	// No user-level tunable params
	"bzip3": {},

	// === Squash-based (LosslessBenchmarkFull only) ===
	// Level not passable through the current binary CLI; defaults used
	"bzip2":  {},
	"lz4":    {},
	"zstd":   {},
	"brotli": {},
	"xz":     {},
	"snappy": {},
}

func intPtr(i int) *int {
	return &i
}
