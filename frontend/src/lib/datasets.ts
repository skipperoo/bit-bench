import { formatBytes } from '@/lib/format'
/** Standardized datasets served from DATASET_DIR (GET /api/v1/datasets). */

export interface DatasetSeries {
  name: string
  values: number
  decimals: number
  size_bytes: number
  /** Set when the file is not a valid .bin; such series cannot be selected. */
  error?: string
}

export interface StandardDataset {
  name: string
  description?: string
  source?: string
  series: DatasetSeries[]
}

export interface DatasetListResponse {
  datasets: StandardDataset[]
  transforms: string[]
  max_runs: number
  max_inputs_per_run: number
  max_chunks_per_series: number
}

export type Transform = 'std' | 'gap' | 'gap_shifted'
export type Aggregation = 'mean' | 'median' | 'pooled'

export const TRANSFORM_INFO: Record<Transform, { label: string; help: string }> = {
  std: { label: 'std', help: 'Values as recorded.' },
  gap: { label: 'gap', help: 'First value, then the difference to the previous value.' },
  gap_shifted: {
    label: 'gap_shifted',
    help: 'Gaps shifted by their minimum so every value is ≥ 0 (first value minus the chunk minimum).',
  },
}

export const AGGREGATION_INFO: Record<Aggregation, { label: string; help: string }> = {
  mean: { label: 'Mean', help: 'Arithmetic mean of every metric over the inputs.' },
  median: { label: 'Median', help: 'Per-metric median: robust to outlier chunks.' },
  pooled: {
    label: 'Pooled',
    help: 'All inputs as one dataset: summed sizes, ratio = Σcompressed / Σuncompressed, throughput = total data / total time.',
  },
}

/** Chunk-size presets, in samples (from small blocks to long records). */
export const CHUNK_PRESETS: { samples: number }[] = [
  { samples: 256 },
  { samples: 768 },
  { samples: 4096 },
  { samples: 8192 },
  { samples: 16384 },
  { samples: 32768 },
  { samples: 786432 },
]

/** What a chunk of `samples` values weighs at 16 bits per sample (e.g. 4,096 samples = 8.0 KB). */
export function chunkSizeHint(samples: number): string {
  return `${samples.toLocaleString()} samples = ${formatBytes(samples * 2)} of 16-bit data`
}

/** Chunk size 0 means "benchmark the whole series as one input". */
export const WHOLE_SERIES = 0

/** Full chunks of a series (a trailing partial chunk is discarded). */
export function chunkCount(values: number, chunkSize: number): number {
  if (chunkSize === WHOLE_SERIES) return values > 0 ? 1 : 0
  return Math.floor(values / chunkSize)
}

/** Inputs one series contributes under (chunk size, max chunks). */
export function plannedChunks(values: number, chunkSize: number, maxChunks: number): number {
  const total = chunkCount(values, chunkSize)
  return maxChunks > 0 ? Math.min(total, maxChunks) : total
}

export interface RunPlan {
  chunkSize: number
  transform: Transform
  inputs: number
  /** Series shorter than one chunk (skipped by the server). */
  skipped: string[]
}

/** Mirrors the server's planning: one run per (transform, chunk size). */
export function planRuns(
  series: DatasetSeries[],
  chunkSizes: number[],
  maxChunks: number,
  transforms: Transform[],
): RunPlan[] {
  const sizes = [...new Set(chunkSizes)].sort((a, b) => a - b)
  const runs: RunPlan[] = []
  for (const transform of transforms) {
    for (const chunkSize of sizes) {
      let inputs = 0
      const skipped: string[] = []
      for (const s of series) {
        const n = plannedChunks(s.values, chunkSize, maxChunks)
        if (n === 0) skipped.push(s.name)
        inputs += n
      }
      runs.push({ chunkSize, transform, inputs, skipped })
    }
  }
  return runs
}

/** Short description of a run's chunking, e.g. "768 × ≤10" or "whole series". */
export function describeChunking(chunkSize: number, maxChunks: number): string {
  if (chunkSize === WHOLE_SERIES) return 'whole series'
  return maxChunks > 0 ? `${chunkSize.toLocaleString()} samples × ≤${maxChunks}` : `${chunkSize.toLocaleString()} samples`
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** One-line description of a benchmark's dataset source and aggregation. */
export function describeSource(b: {
  source?: { dataset: string; series: string[]; chunk_size: number; max_chunks: number; transform: string; inputs: number }
  aggregation?: string
}): string {
  const parts: string[] = []
  if (b.source) {
    parts.push(`${b.source.dataset} (${b.source.series.length} series)`)
    parts.push(b.source.transform)
    parts.push(b.source.chunk_size === WHOLE_SERIES ? 'whole series' : `${b.source.chunk_size.toLocaleString()}-sample chunks`)
    parts.push(`${b.source.inputs} inputs`)
  }
  if (b.aggregation && b.aggregation !== 'mean') parts.push(`${b.aggregation} aggregation`)
  return parts.join(' · ')
}

export interface DatasetSelection {
  dataset: string
  series: string[]
  chunkSizes: number[]
  maxChunks: number
  transforms: Transform[]
}

export const DEFAULT_DATASET_SELECTION: DatasetSelection = {
  dataset: '',
  series: [],
  chunkSizes: [768],
  maxChunks: 10,
  transforms: ['std'],
}

/** Validation message for a selection, or '' when it can be submitted. */
export function datasetSelectionError(
  selection: DatasetSelection,
  dataset: StandardDataset | undefined,
  limits: Pick<DatasetListResponse, 'max_runs' | 'max_inputs_per_run'> | null,
): string {
  if (!dataset) return 'Choose a dataset'
  if (selection.series.length === 0) return 'Select at least one series'
  if (selection.chunkSizes.length === 0) return 'Choose a chunk size or the whole series'
  if (selection.transforms.length === 0) return 'Choose at least one transform'
  const series = dataset.series.filter((s) => selection.series.includes(s.name))
  const runs = planRuns(series, selection.chunkSizes, selection.maxChunks, selection.transforms)
  if (limits && runs.length > limits.max_runs) return `At most ${limits.max_runs} benchmarks per run (${runs.length} selected)`
  const empty = runs.find((r) => r.inputs === 0)
  if (empty) return `Chunk size ${empty.chunkSize} is longer than every selected series`
  const tooBig = limits && runs.find((r) => r.inputs > limits.max_inputs_per_run)
  if (tooBig) return `Chunk size ${tooBig.chunkSize} yields ${tooBig.inputs} inputs (max ${limits!.max_inputs_per_run}); lower "max chunks"`
  return ''
}

