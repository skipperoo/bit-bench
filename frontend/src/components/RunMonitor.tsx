import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import StatusPill from '@/components/StatusPill'
import { apiFetch } from '@/lib/api'
import { formatDuration } from '@/lib/experiments'
import { summarizeTasks } from '@/lib/runs'
import type { TaskView } from '@/lib/runs'
import { isActive } from '@/lib/status'
import type { Benchmark } from '@/types'

/**
 * Live view of benchmarks that are not ready: progress, rough ETA, task table
 * and cancel for active runs; the reason for failed/cancelled ones.
 */
export default function RunMonitor({ benchmarks, onChange }: { benchmarks: Benchmark[]; onChange: () => void }) {
  return (
    <div className="space-y-3">
      {benchmarks.map((b) => <RunCard key={b.id} benchmark={b} onChange={onChange} />)}
    </div>
  )
}

function RunCard({ benchmark: b, onChange }: { benchmark: Benchmark; onChange: () => void }) {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [showTasks, setShowTasks] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const active = isActive(b.status)

  useEffect(() => {
    if (!active) return
    let alive = true
    const load = () => apiFetch<{ tasks: TaskView[] }>(`/benchmarks/${b.id}/tasks`)
      .then((d) => { if (alive) setTasks(Array.isArray(d?.tasks) ? d.tasks : []) })
      .catch(() => {})
    load()
    const timer = setInterval(load, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [b.id, active])

  const summary = summarizeTasks(tasks)
  const cancel = async () => {
    if (!confirm(`Cancel "${b.name}"? Running tasks finish, queued ones are dropped.`)) return
    setCancelling(true)
    try {
      await apiFetch(`/benchmarks/${b.id}/cancel`, { method: 'POST' })
      onChange()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <section aria-label={`Run ${b.name}`} className="rounded-md border border-border p-3 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{b.name}</span>
        <StatusPill status={b.status} progress={b.progress} />
        {active && summary.total > 0 && (
          <span className="text-xs text-muted-foreground">
            {summary.done}/{summary.total} tasks · {summary.running} running
            {summary.etaMs != null && ` · ≈ ${formatDuration(summary.etaMs)} left`}
          </span>
        )}
        {active && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={cancel} disabled={cancelling}>Cancel run</Button>
        )}
      </div>
      {active && (
        <div className="h-1.5 w-full rounded-full bg-secondary" role="progressbar" aria-valuenow={b.progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-1.5 rounded-full bg-foreground transition-all" style={{ width: `${b.progress ?? 0}%` }} />
        </div>
      )}
      {!active && b.error && <p className="text-destructive">{b.error}</p>}
      {b.status === 'queued' && <p className="text-xs text-muted-foreground">Waiting for free workers; higher-priority groups go first.</p>}
      {active && tasks.length > 0 && (
        <div>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" aria-expanded={showTasks} onClick={() => setShowTasks((v) => !v)}>
            {showTasks ? 'Hide tasks' : `Show ${tasks.length} tasks`}
          </button>
          {showTasks && (
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-2">#</th><th className="py-1 pr-2">Input</th><th className="py-1 pr-2">Compressor</th>
                    <th className="py-1 pr-2">Status</th><th className="py-1 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => {
                    const end = t.finished_at ? new Date(t.finished_at).getTime() : Date.now()
                    const dur = t.started_at ? end - new Date(t.started_at).getTime() : undefined
                    return (
                      <tr key={t.seq} className="border-b border-border last:border-0">
                        <td className="py-1 pr-2 tabular-nums">{t.seq}</td>
                        <td className="py-1 pr-2 font-mono">{t.input}</td>
                        <td className="py-1 pr-2 font-mono">{t.compressor}{t.workers > 1 ? ` (${t.workers} workers)` : ''}</td>
                        <td className={`py-1 pr-2 ${t.status === 'failed' ? 'text-destructive' : ''}`} title={t.error}>{t.status}</td>
                        <td className="py-1 text-right tabular-nums">{formatDuration(dur)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
