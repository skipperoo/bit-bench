import { describe, expect, it } from 'vitest'
import {
  PLATFORM_AMD64,
  PLATFORM_ARM64,
  emulatedInstances,
  emulatedSelection,
  isEmulated,
  normalizePlatform,
  platformArch,
} from './platforms'

describe('normalizePlatform', () => {
  it('normalizes supported platform strings', () => {
    expect(normalizePlatform('linux/amd64')).toBe(PLATFORM_AMD64)
    expect(normalizePlatform('linux/arm64')).toBe(PLATFORM_ARM64)
    expect(normalizePlatform('linux/arm64/v8')).toBe(PLATFORM_ARM64)
    expect(normalizePlatform(' LINUX/ARM64 ')).toBe(PLATFORM_ARM64)
    expect(normalizePlatform('linux/aarch64')).toBe(PLATFORM_ARM64)
  })

  it('rejects unsupported or malformed values', () => {
    expect(normalizePlatform('')).toBeNull()
    expect(normalizePlatform(undefined)).toBeNull()
    expect(normalizePlatform('arm64')).toBeNull()
    expect(normalizePlatform('windows/amd64')).toBeNull()
    expect(normalizePlatform('linux/ppc64le')).toBeNull()
  })
})

describe('isEmulated', () => {
  it('compares the package platform with the host platform', () => {
    expect(isEmulated('linux/arm64', 'linux/amd64')).toBe(true)
    expect(isEmulated('linux/amd64', 'linux/amd64')).toBe(false)
    expect(isEmulated('linux/arm64/v8', 'linux/arm64')).toBe(false)
  })

  it('does not warn without both platforms', () => {
    expect(isEmulated(undefined, 'linux/amd64')).toBe(false)
    expect(isEmulated('linux/arm64', undefined)).toBe(false)
  })
})

describe('platformArch', () => {
  it('returns the architecture component', () => {
    expect(platformArch('linux/arm64')).toBe('arm64')
    expect(platformArch('linux/amd64')).toBe('amd64')
    expect(platformArch(undefined)).toBe('unknown')
  })
})

describe('emulatedSelection', () => {
  it('lists unique selected packages that target another platform', () => {
    const instances = [{ name: 'pkg_arm' }, { name: 'pkg_arm' }, { name: 'pkg_native' }]
    const platforms = { pkg_arm: 'linux/arm64', pkg_native: 'linux/amd64' }
    expect(emulatedSelection(instances, platforms, 'linux/amd64')).toEqual([
      { name: 'pkg_arm', platform: 'linux/arm64' },
    ])
  })

  it('ignores built-ins and packages without metadata', () => {
    expect(emulatedSelection([{ name: 'gzip' }], {}, 'linux/amd64')).toEqual([])
  })
})

describe('emulatedInstances', () => {
  it('filters benchmark instances flagged as emulated', () => {
    expect(
      emulatedInstances([
        { name: 'pkg_arm', label: 'pkg_arm', emulated: true },
        { name: 'gzip', label: 'gzip · level 9' },
      ])
    ).toHaveLength(1)
  })
})
