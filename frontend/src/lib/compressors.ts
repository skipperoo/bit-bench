// Compressor naming, colors, and shapes — mirrored from scripts/generate_full_html_report.py

export const COMPRESSOR_RENAMES: Record<string, string> = {
  b_star_gef_approximate: 'B*-GEF (Approx)',
  b_star_gef_optimal: 'B*-GEF (Opt)',
  b_gef_approximate: 'B-GEF (Approx)',
  b_gef_optimal: 'B-GEF (Opt)',
  rle_gef: 'RLE-GEF',
  u_gef_approximate: 'U-GEF (Approx)',
  u_gef_optimal: 'U-GEF (Opt)',
  snappy: 'Snappy',
  pfordelta: 'PForDelta',
  pfordelta_simdnewpfor: 'PForDelta',
  bzip2: 'Bzip2',
  bzip3: 'Bzip3',
  gzip: 'Gzip',
  neats: 'NeaTS',
  dac: 'DAC',
  alp: 'ALP',
  gorilla: 'Gorilla',
  chimp: 'Chimp',
  chimp128: 'Chimp128',
  tsxor: 'TSXor',
  elf: 'Elf',
  camel: 'Camel',
  falcon: 'Falcon',
  lz4: 'LZ4',
  zstd: 'Zstd',
  brotli: 'Brotli',
  xz: 'XZ',
}

/** Display name of a base compressor; FastPFor codecs become "PForDelta (codec)". */
function renameBase(base: string): string {
  const lower = base.toLowerCase()
  if (COMPRESSOR_RENAMES[lower]) return COMPRESSOR_RENAMES[lower]
  if (lower.startsWith(PFORDELTA_PREFIX)) return `PForDelta (${base.slice(PFORDELTA_PREFIX.length)})`
  return base
}

export function renameCompressor(name: string): string {
  const { base, config } = splitCompressorLabel(name)
  const renamed = renameBase(base)
  return config ? `${renamed}${LABEL_SEPARATOR}${config}` : renamed
}

const PFORDELTA_PREFIX = 'pfordelta_'

/** Built-in algorithm names (registry keys plus the explicit pfordelta codecs). */
export function isBuiltinCompressor(name: string): boolean {
  const lower = splitCompressorLabel(name).base.toLowerCase()
  return lower in COMPRESSOR_RENAMES || lower.startsWith(PFORDELTA_PREFIX)
}

/** Separator between a compressor name and its brief configuration label. */
export const LABEL_SEPARATOR = ' · '

/** Splits "gzip · level 9" into its base name and configuration suffix. */
export function splitCompressorLabel(name: string): { base: string; config: string } {
  const idx = name.indexOf(LABEL_SEPARATOR)
  if (idx === -1) return { base: name, config: '' }
  return { base: name.slice(0, idx), config: name.slice(idx + LABEL_SEPARATOR.length) }
}

// Per-compressor hex colors (same as COMPRESSOR_COLORS in the Python script)
export const COMPRESSOR_COLORS: Record<string, string> = {
  'B*-GEF (Approx)': '#1f77b4',
  'B*-GEF (Opt)': '#ff7f0e',
  'B-GEF (Approx)': '#2ca02c',
  'B-GEF (Opt)': '#9467bd',
  'RLE-GEF': '#d62728',
  'U-GEF (Approx)': '#e377c2',
  'U-GEF (Opt)': '#bcbd22',
  Bzip2: '#8c564b',
  Bzip3: '#17becf',
  Brotli: '#17becf',
  Gzip: '#1f77b4',
  LZ4: '#2ca02c',
  Snappy: '#9467bd',
  XZ: '#d62728',
  Zstd: '#e377c2',
  Camel: '#9467bd',
  Chimp: '#8c564b',
  Chimp128: '#e377c2',
  Elf: '#17becf',
  Falcon: '#e6194b',
  Gorilla: '#1f77b4',
  NeaTS: '#ff7f0e',
  TSXor: '#d62728',
  PForDelta: '#2ca02c',
  DAC: '#bcbd22',
  ALP: '#bcbd22',
}

// Compressor families (from COMPRESSOR_FAMILIES_ORDERED in the Python script)
export const COMPRESSOR_FAMILIES: Record<string, string> = {
  Bzip2: 'Block-sorting',
  Bzip3: 'Block-sorting',
  Brotli: 'Dictionary-based',
  Gzip: 'Dictionary-based',
  LZ4: 'Dictionary-based',
  Snappy: 'Dictionary-based',
  XZ: 'Dictionary-based',
  Zstd: 'Dictionary-based',
  ALP: 'Time Series',
  Camel: 'Time Series',
  Chimp: 'Time Series',
  Chimp128: 'Time Series',
  Elf: 'Time Series',
  Falcon: 'Time Series',
  Gorilla: 'Time Series',
  NeaTS: 'Time Series',
  TSXor: 'Time Series',
  'B*-GEF (Approx)': 'GEF',
  'B*-GEF (Opt)': 'GEF',
  'B-GEF (Approx)': 'GEF',
  'B-GEF (Opt)': 'GEF',
  'RLE-GEF': 'GEF',
  'U-GEF (Approx)': 'GEF',
  'U-GEF (Opt)': 'GEF',
  'PForDelta': 'PForDelta',
  DAC: 'DAC',
}

// Plotly marker shapes per family (from FAMILY_PLOTLY_SYMBOLS)
export const FAMILY_SHAPES: Record<string, string> = {
  'Block-sorting': 'square',
  'Dictionary-based': 'diamond',
  'Time Series': 'circle',
  GEF: 'triangle-up',
  PForDelta: 'star',
  DAC: 'pentagon',
  Custom: 'cross',
  Others: 'circle',
}

/** Family of a compressor; user packages form the "Custom" family. */
export function getCompressorFamily(name: string): string {
  if (!isBuiltinCompressor(name)) return 'Custom'
  const display = renameBase(splitCompressorLabel(name).base)
  if (display.startsWith('PForDelta')) return 'PForDelta'
  return COMPRESSOR_FAMILIES[display] ?? 'Others'
}

/**
 * Palette for user packages: distinct from the thesis colours above so a
 * custom coder never looks like a built-in one. A package keeps the same colour
 * everywhere (hash of its name) unless its spec.yaml sets `color`.
 */
export const CUSTOM_PALETTE = [
  '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f',
  '#a21caf', '#c2410c', '#1e3a8a', '#047857', '#9f1239', '#6d28d9',
]

const customColorOverrides = new Map<string, string>()

/** Registers package colours declared in spec.yaml (`color: "#rrggbb"`). */
export function registerCompressorColors(colors: Record<string, string | undefined>): void {
  for (const [name, color] of Object.entries(colors)) {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) customColorOverrides.set(name.toLowerCase(), color.toLowerCase())
  }
}

function hashString(s: string): number {
  let h = 0x811c9dc5 // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Base colour of a compressor (ignores the configuration label). */
export function getCompressorColor(name: string): string {
  const base = splitCompressorLabel(name).base
  if (!isBuiltinCompressor(base)) {
    return customColorOverrides.get(base.toLowerCase()) ?? CUSTOM_PALETTE[hashString(base.toLowerCase()) % CUSTOM_PALETTE.length]
  }
  const display = renameBase(base)
  if (COMPRESSOR_COLORS[display]) return COMPRESSOR_COLORS[display]
  if (display.startsWith('PForDelta')) {
    // Codecs other than the default share the PForDelta hue at varied lightness.
    return shadeColor(COMPRESSOR_COLORS.PForDelta, ((hashString(display) % 5) - 2) * 0.12)
  }
  return '#64748b'
}

export function getCompressorShape(name: string): string {
  return FAMILY_SHAPES[getCompressorFamily(name)] ?? 'circle'
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

/**
 * Lightens (amount > 0, towards white) or darkens (amount < 0, towards black)
 * a hex colour; amount in [-1, 1].
 */
export function shadeColor(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const target = amount >= 0 ? 255 : 0
  const t = Math.min(1, Math.abs(amount))
  return rgbToHex(r + (target - r) * t, g + (target - g) * t, b + (target - b) * t)
}

/** Lightness offsets for the 2nd, 3rd, … configuration of one compressor. */
const VARIANT_SHADES = [-0.3, 0.3, -0.5, 0.45, -0.15, 0.15, -0.65, 0.6]

/**
 * Assigns a colour to every compressor label of a result set. Instances of
 * the same algorithm share its hue: the first (preferably the unconfigured
 * one) gets the base colour, further configurations get darker/lighter shades,
 * so "gzip · level 1" and "gzip · level 9" stay distinguishable.
 */
export function assignCompressorColors(names: string[]): Map<string, string> {
  const unique = [...new Set(names)]
  const byBase = new Map<string, string[]>()
  for (const name of unique) {
    const base = splitCompressorLabel(name).base.toLowerCase()
    byBase.set(base, [...(byBase.get(base) ?? []), name])
  }
  const colors = new Map<string, string>()
  for (const group of byBase.values()) {
    // Unconfigured first, then by label for a stable order.
    const ordered = [...group].sort((a, b) =>
      Number(Boolean(splitCompressorLabel(a).config)) - Number(Boolean(splitCompressorLabel(b).config)) || a.localeCompare(b))
    const baseColor = getCompressorColor(ordered[0])
    ordered.forEach((name, i) => {
      colors.set(name, i === 0 ? baseColor : shadeColor(baseColor, VARIANT_SHADES[(i - 1) % VARIANT_SHADES.length]))
    })
  }
  return colors
}

/** Reads the optional spec.yaml colour of a package API object. */
export function packageColor(spec: unknown): string | undefined {
  if (spec && typeof spec === 'object' && 'color' in spec) {
    const color = (spec as { color?: unknown }).color
    return typeof color === 'string' ? color : undefined
  }
  return undefined
}

export interface CompressorStyle {
  color: string
  shape: string
}

/**
 * Shapes used to tell apart compressors that share a colour. The report
 * palette reuses colours across families (Gzip, Gorilla and B*-GEF are all
 * #1f77b4; ALP, DAC and U-GEF (Opt) share #bcbd22): colours are kept for
 * parity with the thesis plots, and shapes disambiguate.
 */
export const ALTERNATE_SHAPES = ['triangle-down', 'hexagon', 'x', 'square', 'diamond', 'star', 'pentagon', 'triangle-up', 'circle', 'cross']

/** Every marker shape the charts can draw (mirrors model.ChartShapes in the backend). */
export const CHART_SHAPES = ['circle', 'square', 'diamond', 'triangle-up', 'triangle-down', 'star', 'pentagon', 'hexagon', 'x', 'cross']

/** Key of a compressor label in the per-user shape overrides. */
export function shapeKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Colour and marker shape for every compressor label of a result set:
 * colours as in assignCompressorColors, shapes by family, and whenever
 * several labels share a colour, each of them gets a different shape.
 * `overrides` (the user's saved choices, keyed by shapeKey) always win; the
 * automatic shapes of the other labels avoid them.
 */
export function assignCompressorStyles(names: string[], overrides: Record<string, string> = {}): Map<string, CompressorStyle> {
  const colors = assignCompressorColors(names)
  const byColor = new Map<string, string[]>()
  for (const [name, color] of colors) byColor.set(color, [...(byColor.get(color) ?? []), name])
  const styles = new Map<string, CompressorStyle>()
  for (const [color, group] of byColor) {
    const taken = new Set<string>()
    const auto: string[] = []
    for (const name of group) {
      const chosen = overrides[shapeKey(name)]
      if (chosen && CHART_SHAPES.includes(chosen)) {
        taken.add(chosen)
        styles.set(name, { color, shape: chosen })
      } else {
        auto.push(name)
      }
    }
    for (const name of auto.sort()) {
      let shape = getCompressorShape(name)
      if (taken.has(shape)) shape = ALTERNATE_SHAPES.find((s) => !taken.has(s)) ?? shape
      taken.add(shape)
      styles.set(name, { color, shape })
    }
  }
  return styles
}
