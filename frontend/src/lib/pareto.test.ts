import { describe, it, expect } from 'vitest'
import { paretoRanking } from './pareto'
import type { BenchmarkResult } from '@/types'

function r(compressor: string, ratio: number, tp?: number): BenchmarkResult {
  return {
    id: compressor, benchmark_id: 'b', compressor, dataset: 'd',
    compression_ratio: ratio, compression_throughput_mbs: tp,
  }
}

describe('paretoRanking', () => {
  it('counts dominating compressors and sorts by (count, ratio)', () => {
    const ranking = paretoRanking([
      r('slow-small', 0.2, 10),
      r('fast-big', 0.6, 900),
      r('dominated', 0.7, 100), // dominated by fast-big and balanced
      r('balanced', 0.4, 300),
    ])
    expect(ranking.map((e) => e.compressor)).toEqual(['slow-small', 'balanced', 'fast-big', 'dominated'])
    expect(ranking.find((e) => e.compressor === 'dominated')?.dominationCount).toBe(2)
    expect(ranking.filter((e) => e.dominationCount === 0)).toHaveLength(3)
  })

  it('requires a strict improvement to dominate', () => {
    const ranking = paretoRanking([r('a', 0.5, 100), r('b', 0.5, 100)])
    expect(ranking.every((e) => e.dominationCount === 0)).toBe(true)
  })

  it('falls back to the ratio objective when no throughput is reported', () => {
    const ranking = paretoRanking([r('x', 0.5), r('y', 0.3), r('z', 0.9)])
    expect(ranking.map((e) => [e.compressor, e.dominationCount])).toEqual([['y', 0], ['x', 1], ['z', 2]])
  })

  it('ignores results without a ratio', () => {
    const noRatio = { ...r('n', 0), compression_ratio: undefined }
    expect(paretoRanking([noRatio, r('a', 0.5, 1)]).map((e) => e.compressor)).toEqual(['a'])
  })
})
