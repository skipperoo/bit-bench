import type { CompressorPackage } from '@/types'

export const PACKAGE_STATUS_CLASSES: Record<string, string> = {
  building:
    'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  ready: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
}

export const PACKAGE_STATUS_DOT: Record<string, string> = {
  building: 'bg-yellow-500',
  ready: 'bg-green-500',
  failed: 'bg-red-500',
}

export function packageStatusLabel(status: string): string {
  switch (status) {
    case 'building':
      return 'Building'
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Failed'
    default:
      return status
  }
}

export function canManagePackage(
  role: string | null,
  userId: string | null,
  groupID: string | null,
  pkg: CompressorPackage
): boolean {
  if (!role) return false
  if (role === 'admin') return true
  if (userId && pkg.owner_id === userId) return true
  if (role === 'professor' && groupID && pkg.group_id) {
    return groupID === pkg.group_id
  }
  return false
}
