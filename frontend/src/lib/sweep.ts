import type { Benchmark } from '@/types'

export interface SweepPoint {
  chunkSize: number
  benchmark: Benchmark
}

export interface Sweep {
  dataset: string
  transforms: string[]
  /** Distinct chunk sizes, ascending (0 = whole series, plotted last). */
  chunkSizes: number[]
  byTransform: Map<string, SweepPoint[]>
}

/**
 * Detects a chunk-size sweep: at least two benchmarks of the same dataset
 * with different chunk sizes for one transform (what a dataset run with
 * several sizes produces). Returns null otherwise.
 */
export function detectSweep(benchmarks: Benchmark[]): Sweep | null {
  const withSource = benchmarks.filter((b) => b.source)
  if (withSource.length < 2) return null
  const dataset = withSource[0].source!.dataset
  if (!withSource.every((b) => b.source!.dataset === dataset)) return null

  const byTransform = new Map<string, SweepPoint[]>()
  for (const b of withSource) {
    const t = b.source!.transform
    byTransform.set(t, [...(byTransform.get(t) ?? []), { chunkSize: b.source!.chunk_size, benchmark: b }])
  }
  const order = (n: number) => (n === 0 ? Number.MAX_SAFE_INTEGER : n)
  for (const points of byTransform.values()) points.sort((a, b) => order(a.chunkSize) - order(b.chunkSize))
  const chunkSizes = [...new Set(withSource.map((b) => b.source!.chunk_size))].sort((a, b) => order(a) - order(b))
  if (![...byTransform.values()].some((points) => new Set(points.map((p) => p.chunkSize)).size >= 2)) return null
  return { dataset, transforms: [...byTransform.keys()].sort(), chunkSizes, byTransform }
}

export function chunkLabel(chunkSize: number): string {
  if (chunkSize === 0) return 'whole'
  if (chunkSize >= 1024 && chunkSize % 1024 === 0) return `${chunkSize / 1024}Ki`
  return String(chunkSize)
}
