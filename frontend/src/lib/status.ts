import type { Benchmark } from '@/types'

export type BenchmarkStatus = Benchmark['status']

/** Pill colours per status (single source for every page). */
export const STATUS_STYLES: Record<BenchmarkStatus, { pill: string; dot: string }> = {
  queued: { pill: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/60 dark:text-blue-200 dark:border-blue-800', dot: 'bg-blue-500' },
  in_progress: { pill: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950/60 dark:text-yellow-200 dark:border-yellow-800', dot: 'bg-yellow-500' },
  ready: { pill: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950/60 dark:text-green-200 dark:border-green-800', dot: 'bg-green-500' },
  failed: { pill: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950/60 dark:text-red-200 dark:border-red-800', dot: 'bg-red-500' },
  timed_out: { pill: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/60 dark:text-orange-200 dark:border-orange-800', dot: 'bg-orange-500' },
  cancelled: { pill: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-white/5 dark:text-gray-300 dark:border-gray-600', dot: 'bg-gray-500' },
}

export const ACTIVE_STATUSES = new Set<BenchmarkStatus>(['queued', 'in_progress'])

export function isActive(status: BenchmarkStatus): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function statusLabel(status: BenchmarkStatus, progress?: number): string {
  const label = status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return status === 'in_progress' && progress != null ? `${label} (${progress}%)` : label
}
