import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import type { ReceivedShare } from '@/types'

/** Private links other users shared with the current user; hidden when there are none. */
export default function SharedWithMe() {
  const [shares, setShares] = useState<ReceivedShare[]>([])
  useEffect(() => {
    apiFetch<{ shares: ReceivedShare[] }>('/shares/received')
      .then((d) => setShares(d?.shares ?? []))
      .catch(() => {})
  }, [])
  if (shares.length === 0) return null
  return (
    <details className="rounded-md border border-border p-3" open={shares.length <= 3}>
      <summary className="cursor-pointer text-sm font-medium">Shared with me ({shares.length})</summary>
      <ul className="mt-2 divide-y divide-border text-sm">
        {shares.map((s) => (
          <li key={s.token} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <Link to={`/s/${s.token}`} className="min-w-0 truncate hover:underline">
              {s.benchmark_names.length > 1 ? `${s.benchmark_names[0]} + ${s.benchmark_names.length - 1} more` : s.benchmark_names[0] ?? 'Benchmarks'}
            </Link>
            <span className="text-xs text-muted-foreground">
              from {s.owner_email}{s.expires_at && ` · until ${new Date(s.expires_at).toLocaleDateString()}`}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
