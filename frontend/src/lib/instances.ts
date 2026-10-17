import type { CompressorOption, CompressorRegistry } from '@/types'
import { LABEL_SEPARATOR } from '@/lib/compressors'

export const MAX_INSTANCES_PER_BENCHMARK = 64
export const MAX_LABEL_LEN = 64

/** Options the native C++ harness applies per entry. */
const NATIVE_OPTIONS = new Set(['level', 'max_bpc', 'lossy', 'max_precision', 'decimals'])

export interface InstanceDraft {
  name: string
  options: Record<string, unknown>
}

/** Fills every schema option with its default value. */
export function defaultOptions(schema: Record<string, CompressorOption>): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const [key, opt] of Object.entries(schema)) {
    options[key] = opt.default
  }
  return options
}

/**
 * Mirrors the server-side canonicalization: known keys are filled from
 * defaults, unknown keys are dropped.
 */
export function canonicalOptions(
  schema: Record<string, CompressorOption>,
  provided: Record<string, unknown>
): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const [key, opt] of Object.entries(schema)) {
    const value = provided[key]
    options[key] = value === undefined || value === null ? opt.default : value
  }
  return options
}

/** Brief, automatic configuration label ("gzip · level 9"). */
export function buildLabel(
  name: string,
  schema: Record<string, CompressorOption>,
  options: Record<string, unknown>
): string {
  const keys = Object.keys(schema).sort()
  const parts: string[] = []
  for (const key of keys) {
    const opt = schema[key]
    const value = options[key]
    if (value === undefined || value === opt.default) continue
    if (typeof value === 'boolean') {
      parts.push(value ? key : `${key} off`)
    } else {
      parts.push(`${key} ${value}`)
    }
  }
  const label = parts.length > 0 ? `${name}${LABEL_SEPARATOR}${parts.join(LABEL_SEPARATOR)}` : name
  return label.length > MAX_LABEL_LEN ? label.slice(0, MAX_LABEL_LEN) : label
}

/** Native `-c` entry for a built-in instance (mirrors backend BuildInvocation). */
export function buildInvocation(
  name: string,
  schema: Record<string, CompressorOption>,
  options: Record<string, unknown>
): string {
  let base = name
  if (name === 'pfordelta') {
    const codec = options.codec
    if (typeof codec === 'string' && codec !== '' && codec !== 'simdnewpfor') {
      base = `pfordelta_${codec}`
    }
  }

  const parts: string[] = []
  for (const key of Object.keys(schema).sort()) {
    if (!NATIVE_OPTIONS.has(key)) continue
    const value = options[key]
    if (value === undefined || value === schema[key].default) continue
    if (typeof value === 'boolean') {
      parts.push(`${key}:${value}`)
    } else {
      parts.push(`${key}:${value}`)
    }
  }
  return parts.length > 0 ? `${base}=${parts.join(';')}` : base
}

/** Stable identity used for duplicate detection, matching server semantics. */
export function instanceIdentity(
  name: string,
  schema: Record<string, CompressorOption>,
  options: Record<string, unknown>,
  isCustom: boolean
): string {
  if (!isCustom) {
    return `builtin:${buildInvocation(name, schema, options)}`
  }
  const sorted = Object.keys(options)
    .sort()
    .map((key) => `${key}=${JSON.stringify(options[key])}`)
    .join(';')
  return `custom:${name}:${sorted}`
}

/** Whether the compressor exposes any option that actually changes the run. */
export function hasVariableOptions(schema: Record<string, CompressorOption>): boolean {
  return Object.keys(schema).some((key) => NATIVE_OPTIONS.has(key))
}

/**
 * Whether another instance of a compressor may be added. Custom packages
 * always expose effective options; built-ins without effective options can
 * only be configured once.
 */
export function canAddInstance(
  schema: Record<string, CompressorOption>,
  isCustom: boolean,
  currentCount: number,
  totalCount: number
): boolean {
  if (totalCount >= MAX_INSTANCES_PER_BENCHMARK) return false
  if (!isCustom && !hasVariableOptions(schema) && currentCount > 0) return false
  return true
}

/** Validates the configured instances; returns an error message or null. */
export function validateInstances(
  instances: InstanceDraft[],
  registry: CompressorRegistry,
  customNames: Set<string>
): string | null {
  if (instances.length === 0) return 'Select at least one compressor configuration'
  if (instances.length > MAX_INSTANCES_PER_BENCHMARK) {
    return `At most ${MAX_INSTANCES_PER_BENCHMARK} configurations are allowed`
  }

  const seen = new Set<string>()
  for (const inst of instances) {
    const schema = registry[inst.name] || {}
    const identity = instanceIdentity(inst.name, schema, inst.options, customNames.has(inst.name))
    if (seen.has(identity)) {
      return `Duplicate configuration for ${inst.name}: every instance must differ`
    }
    seen.add(identity)
  }
  return null
}
