import type { BenchmarkResult } from '@/types'

export interface ParetoEntry {
  compressor: string
  /** Number of compressors that dominate this one (0 = Pareto-optimal). */
  dominationCount: number
}

/**
 * Composite Pareto score (spec §3.5): objectives are minimize
 * compression_ratio and maximize compression_throughput_mbs. When no result
 * has a throughput, it falls back to the single ratio objective. Entries are
 * sorted by (domination count, ratio) ascending.
 */
export function paretoRanking(results: BenchmarkResult[]): ParetoEntry[] {
  const valid = results.filter((r) => r.compression_ratio != null && Number.isFinite(r.compression_ratio))
  const twoObjectives = valid.some((r) => r.compression_throughput_mbs != null)

  const dominates = (b: BenchmarkResult, a: BenchmarkResult): boolean => {
    const rb = b.compression_ratio!
    const ra = a.compression_ratio!
    if (!twoObjectives) return rb < ra
    // A missing throughput can never be better than a reported one.
    const tb = b.compression_throughput_mbs ?? -Infinity
    const ta = a.compression_throughput_mbs ?? -Infinity
    return rb <= ra && tb >= ta && (rb < ra || tb > ta)
  }

  return valid
    .map((a) => ({
      compressor: a.compressor,
      ratio: a.compression_ratio!,
      dominationCount: valid.filter((b) => b !== a && dominates(b, a)).length,
    }))
    .sort((x, y) => x.dominationCount - y.dominationCount || x.ratio - y.ratio)
    .map(({ compressor, dominationCount }) => ({ compressor, dominationCount }))
}

/**
 * Pareto front of points minimizing x and maximizing y, sorted by x: the
 * non-dominated points, drawn as a step line over the scatter.
 */
export function paretoFront<T extends { x: number; y: number }>(points: T[]): T[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || b.y - a.y)
  const front: T[] = []
  let best = -Infinity
  for (const p of sorted) {
    if (p.y > best) {
      front.push(p)
      best = p.y
    }
  }
  return front
}

/**
 * One row per compressor averaged over several benchmarks (plain mean of each
 * numeric metric over the benchmarks that have it; self-test failures are summed),
 * for the "all benchmarks" Pareto view.
 */
export function averageResults(sets: BenchmarkResult[][]): BenchmarkResult[] {
  const byCompressor = new Map<string, BenchmarkResult[]>()
  for (const rows of sets) for (const r of rows) byCompressor.set(r.compressor, [...(byCompressor.get(r.compressor) ?? []), r])
  return [...byCompressor.entries()].map(([compressor, rows]) => {
    const out: Record<string, unknown> = { id: `average-${compressor}`, benchmark_id: 'average', compressor, dataset: 'average' }
    const keys = new Set(rows.flatMap((r) => Object.keys(r)))
    for (const k of keys) {
      const vals = rows.map((r) => (r as unknown as Record<string, unknown>)[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (vals.length === 0) continue
      out[k] = k === 'self_test_failures' ? vals.reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0) / vals.length
    }
    return out as unknown as BenchmarkResult
  })
}
