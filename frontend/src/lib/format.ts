// Format helpers shared across pages

const MEMORY_METRICS = new Set(['memory_usage', 'compressor_internal'])

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
