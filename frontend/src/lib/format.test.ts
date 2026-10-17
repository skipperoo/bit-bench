import { describe, expect, it } from 'vitest'
import { formatBytes, formatMetricValue, metricLabel } from './format'

describe('metricLabel', () => {
  it('labels the bits-per-element metrics', () => {
    expect(metricLabel('bits_per_element')).toBe('Bits per Element (b/e)')
    expect(metricLabel('uncompressed_bits_per_element')).toBe('Uncompressed Container (b/e)')
  })

  it('falls back to a humanised key', () => {
    expect(metricLabel('some_other_metric')).toBe('Some Other Metric')
  })
})

describe('formatMetricValue', () => {
  it('formats bits per element', () => {
    expect(formatMetricValue(3.241, 'bits_per_element')).toBe('3.24 b/e')
    expect(formatMetricValue(64, 'uncompressed_bits_per_element')).toBe('64.00 b/e')
  })

  it('formats ratios and memory', () => {
    expect(formatMetricValue(0.5, 'compression_ratio')).toBe('50.00%')
    expect(formatMetricValue(2048, 'memory_usage')).toBe('2.0 KB')
  })
})

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.00 MB')
  })
})
