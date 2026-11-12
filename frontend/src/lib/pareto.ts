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
