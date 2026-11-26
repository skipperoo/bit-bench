import { describe, expect, it } from 'vitest'
import { expiryIn, expiryOnDate, shareState, shareUrl } from './shares'

describe('shares helpers', () => {
  it('builds links from the current origin and keeps the tab', () => {
    expect(shareUrl('abc')).toBe(`${window.location.origin}/s/abc`)
    expect(shareUrl('abc', 'overview')).toBe(`${window.location.origin}/s/abc`)
    expect(shareUrl('abc', 'pareto')).toBe(`${window.location.origin}/s/abc?tab=pareto`)
  })
  it('computes expiries', () => {
    expect(expiryIn(0)).toBeNull()
    expect(expiryIn(1, 0)).toBe(new Date(86_400_000).toISOString())
    expect(expiryOnDate('nope')).toBeNull()
    expect(new Date(expiryOnDate('2030-01-02')!).getDate()).toBe(2)
  })
  it('tells active, expired and revoked links apart', () => {
    expect(shareState({ revoked_at: null, expires_at: null })).toBe('active')
    expect(shareState({ revoked_at: null, expires_at: '2000-01-01T00:00:00Z' })).toBe('expired')
    expect(shareState({ revoked_at: '2000-01-01T00:00:00Z', expires_at: null })).toBe('revoked')
  })
})
