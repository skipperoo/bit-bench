import { describe, expect, it } from 'vitest'
import { canManagePreset, summarizeInstances } from './presets'
import type { BenchmarkPreset, CompressorInstance } from '@/types'

function preset(overrides: Partial<BenchmarkPreset> = {}): BenchmarkPreset {
  return {
    id: 'p1',
    owner_id: 'owner-1',
    group_id: 'g1',
    name: 'preset',
    visibility: 'group',
    compressors: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function instance(label: string): CompressorInstance {
  return { name: 'gzip', options: {}, label }
}

describe('canManagePreset', () => {
  it('allows the owner for any preset', () => {
    expect(canManagePreset('student', 'owner-1', null, preset())).toBe(true)
    expect(canManagePreset('student', 'owner-1', null, preset({ visibility: 'private' }))).toBe(true)
  })

  it('allows admins', () => {
    expect(canManagePreset('admin', 'other', null, preset())).toBe(true)
  })

  it('allows professors of the preset group for shared presets only', () => {
    expect(canManagePreset('professor', 'other', 'g1', preset())).toBe(true)
    expect(canManagePreset('professor', 'other', 'g1', preset({ visibility: 'private' }))).toBe(false)
    expect(canManagePreset('professor', 'other', 'g2', preset())).toBe(false)
  })

  it('denies other roles', () => {
    expect(canManagePreset('phd', 'other', 'g1', preset())).toBe(false)
    expect(canManagePreset(null, null, null, preset())).toBe(false)
  })
})

describe('summarizeInstances', () => {
  it('lists labels and collapses the rest', () => {
    const instances = [instance('gzip · level 1'), instance('gzip · level 9'), instance('gorilla'), instance('zstd')]
    expect(summarizeInstances(instances)).toBe('gzip · level 1, gzip · level 9, gorilla +1 more')
  })

  it('handles empty configurations', () => {
    expect(summarizeInstances([])).toBe('No compressors')
  })
})
