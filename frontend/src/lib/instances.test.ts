import { describe, expect, it } from 'vitest'
import {
  MAX_INSTANCES_PER_BENCHMARK,
  buildInvocation,
  buildLabel,
  canonicalOptions,
  defaultOptions,
  hasVariableOptions,
  instanceIdentity,
  validateInstances,
} from './instances'
import type { CompressorOption, CompressorRegistry } from '@/types'

const gzipSchema: Record<string, CompressorOption> = {
  level: { type: 'number', min: 1, max: 9, default: 6, step: 1 },
}
const neatsSchema: Record<string, CompressorOption> = {
  max_bpc: { type: 'number', min: 0, max: 64, default: 32, step: 1 },
  lossy: { type: 'boolean', default: false },
}
const pforSchema: Record<string, CompressorOption> = {
  codec: { type: 'select', options: ['simdnewpfor', 'pfor'], default: 'simdnewpfor' },
}

describe('defaultOptions / canonicalOptions', () => {
  it('fills defaults', () => {
    expect(defaultOptions(gzipSchema)).toEqual({ level: 6 })
  })

  it('keeps provided values and drops unknown keys', () => {
    expect(canonicalOptions(gzipSchema, { level: 9, nope: true })).toEqual({ level: 9 })
  })

  it('falls back to defaults for missing values', () => {
    expect(canonicalOptions(neatsSchema, { lossy: true })).toEqual({ max_bpc: 32, lossy: true })
  })
})

describe('buildLabel', () => {
  it('shows non-default options only', () => {
    expect(buildLabel('gzip', gzipSchema, { level: 9 })).toBe('gzip · level 9')
    expect(buildLabel('gzip', gzipSchema, { level: 6 })).toBe('gzip')
    expect(buildLabel('neats', neatsSchema, { max_bpc: 16, lossy: true })).toBe('neats · lossy · max_bpc 16')
  })

  it('renders disabled booleans with an off marker', () => {
    const schema: Record<string, CompressorOption> = { verify: { type: 'boolean', default: true } }
    expect(buildLabel('codec', schema, { verify: false })).toBe('codec · verify off')
  })
})

describe('buildInvocation', () => {
  it('renders level options', () => {
    expect(buildInvocation('gzip', gzipSchema, { level: 9 })).toBe('gzip=level:9')
    expect(buildInvocation('gzip', gzipSchema, { level: 6 })).toBe('gzip')
  })

  it('sorts native options', () => {
    expect(buildInvocation('neats', neatsSchema, { max_bpc: 16, lossy: true }))
      .toBe('neats=lossy:true;max_bpc:16')
  })

  it('maps the pfordelta codec to a distinct name', () => {
    expect(buildInvocation('pfordelta', pforSchema, { codec: 'pfor' })).toBe('pfordelta_pfor')
    expect(buildInvocation('pfordelta', pforSchema, { codec: 'simdnewpfor' })).toBe('pfordelta')
  })
})

describe('instanceIdentity', () => {
  it('treats identical built-in configurations as duplicates', () => {
    const a = instanceIdentity('gzip', gzipSchema, { level: 9 }, false)
    const b = instanceIdentity('gzip', gzipSchema, { level: 9 }, false)
    expect(a).toBe(b)
  })

  it('distinguishes different built-in configurations', () => {
    expect(instanceIdentity('gzip', gzipSchema, { level: 9 }, false))
      .not.toBe(instanceIdentity('gzip', gzipSchema, { level: 1 }, false))
  })

  it('distinguishes custom package configurations', () => {
    const schema: Record<string, CompressorOption> = { mode: { type: 'select', options: ['a', 'b'], default: 'a' } }
    expect(instanceIdentity('pkg', schema, { mode: 'a' }, true))
      .not.toBe(instanceIdentity('pkg', schema, { mode: 'b' }, true))
  })
})

describe('hasVariableOptions', () => {
  it('detects native options', () => {
    expect(hasVariableOptions(gzipSchema)).toBe(true)
    expect(hasVariableOptions({})).toBe(false)
    expect(hasVariableOptions({ mode: { type: 'select', options: ['a'], default: 'a' } })).toBe(false)
  })
})

describe('validateInstances', () => {
  const registry: CompressorRegistry = { gzip: gzipSchema, gorilla: {} }

  it('requires at least one instance', () => {
    expect(validateInstances([], registry, new Set())).toContain('at least one')
  })

  it('rejects duplicates', () => {
    const instances = [
      { name: 'gzip', options: { level: 9 } },
      { name: 'gzip', options: { level: 9 } },
    ]
    expect(validateInstances(instances, registry, new Set())).toContain('Duplicate')
  })

  it('accepts different configurations', () => {
    const instances = [
      { name: 'gzip', options: { level: 9 } },
      { name: 'gzip', options: { level: 1 } },
      { name: 'gorilla', options: {} },
    ]
    expect(validateInstances(instances, registry, new Set())).toBeNull()
  })

  it('rejects more than the cap', () => {
    const instances = Array.from({ length: MAX_INSTANCES_PER_BENCHMARK + 1 }, () => ({ name: 'gorilla', options: {} }))
    expect(validateInstances(instances, registry, new Set())).toContain('At most')
  })
})
