import { describe, it, expect } from 'vitest'

interface ParetoInput {
  compressor: string
  compression_ratio: number
  compression_throughput_mbs: number
}

// Returns number of compressors that dominate each compressor (per spec §3.5)
function computeDominationCounts(results: ParetoInput[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of results) {
    let dominatedBy = 0
    for (const b of results) {
      if (a === b) continue
      // b dominates a iff b has ≤ ratio AND ≥ throughput, with at least one strict
      const bDominatesA = b.compression_ratio <= a.compression_ratio &&
        b.compression_throughput_mbs >= a.compression_throughput_mbs
      const strictlyBetter = b.compression_ratio < a.compression_ratio ||
        b.compression_throughput_mbs > a.compression_throughput_mbs
      if (bDominatesA && strictlyBetter) {
        dominatedBy++
      }
    }
    counts.set(a.compressor, dominatedBy)
  }
  return counts
}

describe('computeDominationCounts', () => {
  it('returns empty map for empty input', () => {
    const result = computeDominationCounts([])
    expect(result.size).toBe(0)
  })

  it('single compressor is Pareto-optimal (dominated by none)', () => {
    const result = computeDominationCounts([
      { compressor: 'gzip_6', compression_ratio: 0.5, compression_throughput_mbs: 500 },
    ])
    expect(result.get('gzip_6')).toBe(0)
  })

  it('best compressor is dominated by none', () => {
    const result = computeDominationCounts([
      { compressor: 'A', compression_ratio: 0.3, compression_throughput_mbs: 800 },
      { compressor: 'B', compression_ratio: 0.5, compression_throughput_mbs: 500 },
      { compressor: 'C', compression_ratio: 0.4, compression_throughput_mbs: 600 },
    ])
    // A has best ratio AND best throughput → dominated by nobody
    expect(result.get('A')).toBe(0)
    // B is dominated by A (better ratio AND throughput)
    expect(result.get('B')).toBeGreaterThanOrEqual(1)
    // C is dominated by A (better ratio AND throughput)
    expect(result.get('C')).toBeGreaterThanOrEqual(1)
  })

  it('handles tiebreak correctly', () => {
    const result = computeDominationCounts([
      { compressor: 'A', compression_ratio: 0.5, compression_throughput_mbs: 500 },
      { compressor: 'B', compression_ratio: 0.5, compression_throughput_mbs: 600 },
    ])
    // B dominates A (same ratio, better throughput)
    expect(result.get('A')).toBe(1)
    // A does NOT dominate B (worse throughput)
    expect(result.get('B')).toBe(0)
  })

  it('two-way incomparable (neither dominates)', () => {
    const result = computeDominationCounts([
      { compressor: 'A', compression_ratio: 0.3, compression_throughput_mbs: 400 },
      { compressor: 'B', compression_ratio: 0.5, compression_throughput_mbs: 800 },
    ])
    // A has better ratio; B has better throughput → neither dominates
    expect(result.get('A')).toBe(0)
    expect(result.get('B')).toBe(0)
  })

  it('ranks multiple compressors by domination count', () => {
    const result = computeDominationCounts([
      { compressor: 'A', compression_ratio: 0.2, compression_throughput_mbs: 1000 },
      { compressor: 'B', compression_ratio: 0.3, compression_throughput_mbs: 800 },
      { compressor: 'C', compression_ratio: 0.4, compression_throughput_mbs: 600 },
      { compressor: 'D', compression_ratio: 0.5, compression_throughput_mbs: 400 },
    ])
    // A dominates everyone
    expect(result.get('A')).toBe(0)
    // B is dominated by A
    expect(result.get('B')).toBe(1)
    // C is dominated by A, B
    expect(result.get('C')).toBe(2)
    // D is dominated by A, B, C
    expect(result.get('D')).toBe(3)
  })

  it('falls back to single-objective when all throughput is equal', () => {
    const result = computeDominationCounts([
      { compressor: 'A', compression_ratio: 0.3, compression_throughput_mbs: 500 },
      { compressor: 'B', compression_ratio: 0.5, compression_throughput_mbs: 500 },
    ])
    // A dominates B (better ratio, same throughput → strict: better ratio)
    expect(result.get('A')).toBe(0)
    expect(result.get('B')).toBe(1)
  })
})
