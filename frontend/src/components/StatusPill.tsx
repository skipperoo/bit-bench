import { STATUS_STYLES, isActive, statusLabel } from '@/lib/status'
import type { BenchmarkStatus } from '@/lib/status'

/** Benchmark status pill; active states carry a pulsing dot (spec §3.1.3). */
export default function StatusPill({ status, progress }: { status: BenchmarkStatus; progress?: number }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.cancelled
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${style.pill}`}>
      {isActive(status) && <span className={`inline-block h-2 w-2 rounded-full animate-pulse ${style.dot}`} aria-hidden="true" />}
      {statusLabel(status, progress)}
    </span>
  )
}
