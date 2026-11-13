import { renameCompressor } from '@/lib/compressors'
import { availableMetrics, metricValue } from '@/lib/metrics'
import { signalLabel } from '@/lib/experiments'
import type { SignalResults } from '@/lib/experiments'

/** Serializes rows to CSV (RFC 4180 quoting). */
export function toCSV(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n'
}

/** Triggers a browser download of text content. */
export function downloadText(filename: string, content: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const RAW_COLUMNS = ['num_values', 'original_size', 'uncompressed_bits', 'compressed_bits', 'input_buffer', 'self_test_failures'] as const

/**
 * Every result of every benchmark as one table: one row per (benchmark,
 * signal, compressor), the data source, the raw sizes and every metric in
 * stored units (compression_ratio as a fraction; chunk_size 0 = whole series).
 * `signal` is the series (or input) name, or "all (<aggregation>)" for the
 * benchmark's aggregate.
 */
export function allResultsCSV(items: SignalResults[]): string {
  const metrics = availableMetrics(items.flatMap((i) => i.results)).map((m) => m.key)
  const header = ['benchmark', 'dataset', 'transform', 'chunk_size', 'aggregation', 'signal', 'compressor', 'label', ...RAW_COLUMNS, ...metrics]
  const rows = items.flatMap((item) => item.results.map((r) => [
    item.benchmark.name,
    item.benchmark.source?.dataset ?? item.benchmark.original_filename,
    item.benchmark.source?.transform,
    item.benchmark.source?.chunk_size,
    item.benchmark.aggregation ?? 'mean',
    signalLabel(item),
    renameCompressor(r.compressor),
    r.compressor,
    ...RAW_COLUMNS.map((k) => r[k]),
    ...metrics.map((m) => metricValue(r, m)),
  ]))
  return toCSV(header, rows)
}
