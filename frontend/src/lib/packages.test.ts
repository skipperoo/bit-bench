import { describe, expect, it } from 'vitest'
import { canManagePackage, packageStatusLabel } from './packages'
import type { CompressorPackage } from '@/types'

function pkg(overrides: Partial<CompressorPackage> = {}): CompressorPackage {
  return {
    id: 'p1',
    owner_id: 'owner-1',
    name: 'codec',
    version: '1',
    description: '',
    language: '',
    entrypoint: './run',
    workers: 1,
    spec: {},
    status: 'ready',
    archive_checksum: 'x',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('packageStatusLabel', () => {
  it('labels known statuses', () => {
    expect(packageStatusLabel('building')).toBe('Building')
    expect(packageStatusLabel('ready')).toBe('Ready')
    expect(packageStatusLabel('failed')).toBe('Failed')
  })

  it('passes through unknown statuses', () => {
    expect(packageStatusLabel('weird')).toBe('weird')
  })
})

describe('canManagePackage', () => {
  it('allows admin for any package', () => {
    expect(canManagePackage('admin', 'someone', null, pkg())).toBe(true)
  })

  it('allows the owner', () => {
    expect(canManagePackage('phd', 'owner-1', null, pkg())).toBe(true)
  })

  it('denies other users', () => {
    expect(canManagePackage('student', 'other', null, pkg())).toBe(false)
  })

  it('allows professors for their group', () => {
    expect(canManagePackage('professor', 'other', 'g1', pkg({ group_id: 'g1' }))).toBe(true)
    expect(canManagePackage('professor', 'other', 'g2', pkg({ group_id: 'g1' }))).toBe(false)
  })

  it('denies anonymous users', () => {
    expect(canManagePackage(null, null, null, pkg())).toBe(false)
  })
})
