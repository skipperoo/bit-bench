/**
 * Platform helpers for user-provided compressor packages.
 *
 * A package may declare `platform: linux/arm64` in its spec.yaml. When that
 * differs from the platform of the Docker host, containers run through
 * binfmt/QEMU emulation, which distorts throughput measurements.
 */

export const PLATFORM_AMD64 = 'linux/amd64'
export const PLATFORM_ARM64 = 'linux/arm64'

/** Normalizes a platform string to linux/amd64 or linux/arm64. */
export function normalizePlatform(platform?: string | null): string | null {
  if (!platform) return null
  const parts = platform.trim().toLowerCase().split('/')
  if (parts.length < 2 || parts.length > 3 || parts[0] !== 'linux') return null
  if (parts[1] === 'amd64' || parts[1] === 'x86_64') return PLATFORM_AMD64
  if (parts[1] === 'arm64' || parts[1] === 'aarch64') return PLATFORM_ARM64
  return null
}

/** Whether a package platform differs from the host platform. */
export function isEmulated(platform?: string | null, hostPlatform?: string | null): boolean {
  const target = normalizePlatform(platform)
  const host = normalizePlatform(hostPlatform)
  return target !== null && host !== null && target !== host
}

/** Short architecture label used in badges ("amd64", "arm64"). */
export function platformArch(platform?: string | null): string {
  const normalized = normalizePlatform(platform)
  if (normalized) return normalized.split('/')[1]
  return platform || 'unknown'
}

/** Unique emulated packages in the current selection. */
export function emulatedSelection(
  instances: { name: string }[],
  platformByPackage: Record<string, string | undefined>,
  hostPlatform?: string | null
): { name: string; platform: string }[] {
  const seen = new Set<string>()
  const result: { name: string; platform: string }[] = []
  for (const instance of instances) {
    const platform = normalizePlatform(platformByPackage[instance.name])
    if (!platform || platform === normalizePlatform(hostPlatform)) continue
    if (seen.has(instance.name)) continue
    seen.add(instance.name)
    result.push({ name: instance.name, platform })
  }
  return result
}

/** Emulated instances recorded on a benchmark (historical marker). */
export function emulatedInstances(instances: { name: string; label: string; emulated?: boolean }[]) {
  return instances.filter((instance) => instance.emulated)
}
