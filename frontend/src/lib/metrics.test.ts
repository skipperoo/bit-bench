import { describe, expect, it } from 'vitest'
import { bitsPerElement, uncompressedBitsPerElement, withDerivedMetrics } from './metrics'
import type { BenchmarkResult } from '@/types'

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    id: 'r1',
    benchmark_id: 'b1',
    compressor: 'gorilla',
    dataset: 'test',
    ...overrides,
  }
}

describe('bitsPerElement', () => {
  it('divides compressed bits by the number of values', () => {
    expect(bitsPerElement(result({ compressed_bits: 3200, num_values: 1000 }))).toBe(3.2)
  })

  it('returns undefined when compressed bits are missing', () => {
    expect(bitsPerElement(result({ num_values: 1000 }))).toBeUndefined()
  })

  it('returns undefined for zero or missing value counts', () => {
    expect(bitsPerElement(result({ compressed_bits: 3200, num_values: 0 }))).toBeUndefined()
    expect(bitsPerElement(result({ compressed_bits: 3200 }))).toBeUndefined()
  })
})

describe('uncompressedBitsPerElement', () => {
  it('returns the input container width per element', () => {
    expect(uncompressedBitsPerElement(result({ uncompressed_bits: 64000, num_values: 1000 }))).toBe(64)
  })

  it('returns undefined when data is missing', () => {
    expect(uncompressedBitsPerElement(result({ num_values: 1000 }))).toBeUndefined()
    expect(uncompressedBitsPerElement(result({ uncompressed_bits: 64000 }))).toBeUndefined()
  })
})

describe('withDerivedMetrics', () => {
  it('attaches both derived metrics without mutating the input', () => {
    const original = result({ compressed_bits: 1600, uncompressed_bits: 64000, num_values: 1000 })
    const [derived] = withDerivedMetrics([original])

    expect(derived.bits_per_element).toBe(1.6)
    expect(derived.uncompressed_bits_per_element).toBe(64)
    expect(original.bits_per_element).toBeUndefined()
  })

  it('leaves derivable fields undefined instead of NaN', () => {
    const [derived] = withDerivedMetrics([result({ num_values: 0 })])
    expect(derived.bits_per_element).toBeUndefined()
    expect(derived.uncompressed_bits_per_element).toBeUndefined()
  })
})

describe('ranking direction and range queries', () => {
  it('minimizes sizes, memory and latencies; maximizes throughputs', async () => {
    const { isLowerBetter } = await import('./metrics')
    expect(isLowerBetter('compression_ratio')).toBe(true)
    expect(isLowerBetter('relative_memory_usage')).toBe(true)
    expect(isLowerBetter('decode_ns')).toBe(true)
    expect(isLowerBetter('compression_throughput_mbs')).toBe(false)
    expect(isLowerBetter('range_query_100')).toBe(false)
  })

  it('lists range sizes numerically and reads their values', async () => {
    const { rangeQueryMetrics, metricValue } = await import('./metrics')
    const rows = [
      result({ range_queries: { '1000': 5, '10': 1 } }),
      result({ range_queries: { '100': 2 } }),
    ]
    expect(rangeQueryMetrics(rows)).toEqual(['range_query_10', 'range_query_100', 'range_query_1000'])
    expect(metricValue(rows[0], 'range_query_1000')).toBe(5)
    expect(metricValue(rows[1], 'range_query_1000')).toBeUndefined()
  })
})
