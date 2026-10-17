import type { BenchmarkPreset, CompressorInstance } from '@/types'

/**
 * Mirrors the server-side permission rule: the owner, administrators, and
 * professors of the preset's group (for group-shared presets) may edit or
 * delete a preset.
 */
export function canManagePreset(
  role: string | null,
  userId: string | null,
  groupId: string | null,
  preset: BenchmarkPreset
): boolean {
  if (!role) return false
  if (role === 'admin' || (userId != null && preset.owner_id === userId)) return true
  if (role === 'professor' && preset.visibility === 'group' && groupId && preset.group_id === groupId) {
    return true
  }
  return false
}

/** One-line summary of a configuration, used for preset and history rows. */
export function summarizeInstances(instances: CompressorInstance[], max = 3): string {
  if (instances.length === 0) return 'No compressors'
  const labels = instances.slice(0, max).map((instance) => instance.label).join(', ')
  const extra = instances.length > max ? ` +${instances.length - max} more` : ''
  return labels + extra
}
