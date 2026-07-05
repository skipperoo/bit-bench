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
  bzip2: 'bzip2',
  bzip3: 'bzip3',
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
  lz4: 'lz4',
  zstd: 'zstd',
  brotli: 'Brotli',
  xz: 'XZ',
}

export function renameCompressor(name: string): string {
  const lower = name.toLowerCase()
  if (COMPRESSOR_RENAMES[lower]) return COMPRESSOR_RENAMES[lower]
  return name
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
  bzip2: '#8c564b',
  bzip3: '#17becf',
  Brotli: '#17becf',
  Gzip: '#1f77b4',
  lz4: '#2ca02c',
  Snappy: '#9467bd',
  XZ: '#d62728',
  zstd: '#e377c2',
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
  ALP: '#ff7f0e',
}

// Compressor families (from COMPRESSOR_FAMILIES_ORDERED in the Python script)
export const COMPRESSOR_FAMILIES: Record<string, string> = {
  bzip2: 'Block-sorting',
  bzip3: 'Block-sorting',
  Brotli: 'Dictionary-based',
  Gzip: 'Dictionary-based',
  lz4: 'Dictionary-based',
  Snappy: 'Dictionary-based',
  XZ: 'Dictionary-based',
  zstd: 'Dictionary-based',
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
}

export function getCompressorColor(name: string): string {
  const display = renameCompressor(name)
  if (COMPRESSOR_COLORS[display]) return COMPRESSOR_COLORS[display]
  return '#64748b'
}

export function getCompressorShape(name: string): string {
  const display = renameCompressor(name)
  const family = COMPRESSOR_FAMILIES[display]
  if (family && FAMILY_SHAPES[family]) return FAMILY_SHAPES[family]
  return 'circle'
}
