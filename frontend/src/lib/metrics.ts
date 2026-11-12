import type { BenchmarkResult } from '@/types'

/**
 * Compressed bits per element: the container-independent cost of one value.
 * It is computed from the compressed payload size rather than the original
 * 64-bit container, so it can be compared with a different target container
 * (e.g. int16 streams).
 */
export function bitsPerElement(r: BenchmarkResult): number | undefined {
  if (r.compressed_bits == null || r.num_values == null || r.num_values <= 0) return undefined
  return r.compressed_bits / r.num_values
}

/** Width of the uncompressed input container in bits per element (typically 64). */
export function uncompressedBitsPerElement(r: BenchmarkResult): number | undefined {
  if (r.uncompressed_bits == null || r.num_values == null || r.num_values <= 0) return undefined
  return r.uncompressed_bits / r.num_values
}

/**
 * Returns the results with the derived bit-per-element metrics attached.
 * Derived values are client-side only; the API exposes the raw bit counts and
 * the value count.
 */
export function withDerivedMetrics(results: BenchmarkResult[]): BenchmarkResult[] {
  return results.map((r) => ({
    ...r,
    bits_per_element: bitsPerElement(r),
    uncompressed_bits_per_element: uncompressedBitsPerElement(r),
  }))
}

/** Prefix of the per-range-size metrics flattened from `range_queries`. */
export const RANGE_QUERY_PREFIX = 'range_query_'

const LOWER_IS_BETTER = new Set([
  'compression_ratio', 'compressed_bits', 'uncompressed_bits', 'original_size',
  'memory_usage', 'compressor_internal', 'internal_memory_ratio',
  'relative_memory_usage', 'random_access_ns', 'bits_per_element',
])

/**
 * Ranking direction of a metric (spec §6.5, parity with `is_min_best` in the
 * report script): sizes, memory and latencies are minimized, throughputs and
 * range queries maximized.
 */
export function isLowerBetter(metric: string): boolean {
  return LOWER_IS_BETTER.has(metric) || metric.endsWith('_ns') || metric.endsWith('_bits')
}

/**
 * Range-query metric keys present in the results (`range_query_<N>`), sorted
 * by range size.
 */
export function rangeQueryMetrics(results: BenchmarkResult[]): string[] {
  const sizes = new Set<string>()
  for (const r of results) {
    for (const key of Object.keys(r.range_queries ?? {})) sizes.add(key)
  }
  return [...sizes]
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
    .map((size) => `${RANGE_QUERY_PREFIX}${size}`)
}

/** Reads a numeric metric from a result, including flattened range queries. */
export function metricValue(r: BenchmarkResult, metric: string): number | undefined {
  if (metric.startsWith(RANGE_QUERY_PREFIX)) {
    const v = r.range_queries?.[metric.slice(RANGE_QUERY_PREFIX.length)]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const v = (r as unknown as Record<string, unknown>)[metric]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export type MetricChart = 'bar' | 'scatter'
export type MetricGroup = 'ratio' | 'speed' | 'memory' | 'access' | 'range'

export interface MetricDef {
  key: string
  chart: MetricChart
  group: MetricGroup
}

/** Metric sections in display order (spec §3.4); range queries are appended. */
export const METRIC_DEFS: MetricDef[] = [
  { key: 'compression_ratio', chart: 'bar', group: 'ratio' },
  { key: 'bits_per_element', chart: 'bar', group: 'ratio' },
  { key: 'compression_throughput_mbs', chart: 'scatter', group: 'speed' },
  { key: 'decompression_throughput_mbs', chart: 'scatter', group: 'speed' },
  { key: 'memory_usage', chart: 'bar', group: 'memory' },
  { key: 'compressor_internal', chart: 'bar', group: 'memory' },
  { key: 'relative_memory_usage', chart: 'bar', group: 'memory' },
  { key: 'internal_memory_ratio', chart: 'bar', group: 'memory' },
  { key: 'random_access_ns', chart: 'bar', group: 'access' },
  { key: 'random_access_mbs', chart: 'scatter', group: 'access' },
]

/** Metrics present in at least one result, including range-query sizes. */
export function availableMetrics(results: BenchmarkResult[]): MetricDef[] {
  const has = (key: string) => results.some((r) => metricValue(r, key) != null)
  return [
    ...METRIC_DEFS.filter((m) => has(m.key)),
    ...rangeQueryMetrics(results).map((key) => ({ key, chart: 'scatter' as const, group: 'range' as const })),
  ]
}
