// Format helpers shared across pages

const MEMORY_METRICS = new Set(['memory_usage', 'compressor_internal'])

const METRIC_LABELS: Record<string, string> = {
  compression_ratio: 'Compression Ratio (%)',
  compression_throughput_mbs: 'Compression Throughput (MB/s)',
  decompression_throughput_mbs: 'Decompression Throughput (MB/s)',
  memory_usage: 'Memory Usage (MB)',
  compressor_internal: 'Compressor Memory (MB)',
  random_access_ns: 'Random Access (ns)',
  random_access_mbs: 'Random Access (MB/s)',
  relative_memory_usage: 'Relative Memory Usage',
  internal_memory_ratio: 'Internal Memory Ratio',
}

export function metricLabel(key: string): string {
  return METRIC_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatMetricValue(value: number, metric: string): string {
  if (MEMORY_METRICS.has(metric)) return formatBytes(value)
  if (metric === 'compression_ratio' || metric === 'ratio') return `${(value * 100).toFixed(2)}%`
  return value.toFixed(2)
}
