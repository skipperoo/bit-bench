import { describe, it, expect } from 'vitest'
import { stepsForOption, shouldUseSlider } from './options'

describe('stepsForOption', () => {
  it('calculates steps correctly for range with step=1', () => {
    expect(stepsForOption({ type: 'number', min: 0, max: 64, default: 32, step: 1 })).toBe(64)
  })

  it('calculates steps correctly for range with step=2', () => {
    expect(stepsForOption({ type: 'number', min: 0, max: 10, default: 5, step: 2 })).toBe(5)
  })

  it('returns 0 for boolean options', () => {
    expect(stepsForOption({ type: 'boolean', default: false })).toBe(0)
  })

  it('returns 0 for select options', () => {
    expect(stepsForOption({ type: 'select', options: ['a', 'b'], default: 'a' })).toBe(0)
  })
})

describe('shouldUseSlider', () => {
  it('returns true when steps ≤ 20', () => {
    expect(shouldUseSlider({ type: 'number', min: 1, max: 9, default: 6, step: 1 })).toBe(true)
    expect(shouldUseSlider({ type: 'number', min: 0, max: 18, default: 18, step: 1 })).toBe(true)
    expect(shouldUseSlider({ type: 'number', min: -1, max: 18, default: -1, step: 1 })).toBe(true)
  })

  it('returns false when steps > 20', () => {
    expect(shouldUseSlider({ type: 'number', min: 0, max: 64, default: 32, step: 1 })).toBe(false)
    expect(shouldUseSlider({ type: 'number', min: 0, max: 100, default: 50, step: 1 })).toBe(false)
  })

  it('returns false for non-number types', () => {
    expect(shouldUseSlider({ type: 'boolean', default: false })).toBe(false)
    expect(shouldUseSlider({ type: 'select', options: ['a', 'b'], default: 'a' })).toBe(false)
  })
})
