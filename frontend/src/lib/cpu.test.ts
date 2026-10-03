import { describe, expect, it } from 'vitest'
import { formatLoad, formatMHz, formatUtilization, notableFlags } from './cpu'

describe('notableFlags', () => {
  it('returns present flags in canonical order', () => {
    expect(notableFlags(['popcnt', 'avx2', 'sse2'])).toEqual(['avx2', 'sse2', 'popcnt'])
  })

  it('ignores non-notable and duplicate flags', () => {
    expect(notableFlags(['fpu', 'vme', 'avx2', 'avx2', 'de'])).toEqual(['avx2'])
  })

  it('handles empty input', () => {
    expect(notableFlags([])).toEqual([])
  })
})

describe('formatMHz', () => {
  it('formats GHz', () => {
    expect(formatMHz(4500)).toBe('4.50 GHz')
  })

  it('formats MHz', () => {
    expect(formatMHz(800)).toBe('800 MHz')
  })

  it('handles missing values', () => {
    expect(formatMHz(0)).toBe('--')
  })
})

describe('formatLoad', () => {
  it('formats with two decimals', () => {
    expect(formatLoad(1.2345)).toBe('1.23')
  })

  it('handles non-finite values', () => {
    expect(formatLoad(Number.NaN)).toBe('--')
  })
})

describe('formatUtilization', () => {
  it('rounds to whole percent', () => {
    expect(formatUtilization(42.6)).toBe('43%')
  })

  it('clamps above 100', () => {
    expect(formatUtilization(150)).toBe('100%')
  })

  it('clamps negative values to zero', () => {
    expect(formatUtilization(-5)).toBe('0%')
  })
})
