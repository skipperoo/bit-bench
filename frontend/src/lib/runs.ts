export interface TaskView {
  seq: number
  kind: 'builtin' | 'custom'
  compressor: string
  input: string
  workers: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
  started_at?: string
  finished_at?: string
}

export interface RunSummary {
  total: number
  done: number
  running: number
  queued: number
  failed: number
  /** Mean duration of finished tasks (ms). */
  meanTaskMs?: number
  /** Rough remaining time: pending tasks × mean duration / observed parallelism (ms). */
  etaMs?: number
}

/** Progress and a rough ETA of a running benchmark from its task table. */
export function summarizeTasks(tasks: TaskView[], now = Date.now()): RunSummary {
  const count = (s: TaskView['status']) => tasks.filter((t) => t.status === s).length
  const durations = tasks
    .filter((t) => t.status === 'done' && t.started_at && t.finished_at)
    .map((t) => new Date(t.finished_at!).getTime() - new Date(t.started_at!).getTime())
    .filter((d) => d >= 0)
  const summary: RunSummary = {
    total: tasks.length,
    done: count('done'),
    running: count('running'),
    queued: count('queued'),
    failed: count('failed'),
  }
  if (durations.length > 0) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length
    summary.meanTaskMs = mean
    // Running tasks are assumed half done; the scheduler runs ~`running` in parallel.
    const parallel = Math.max(1, summary.running)
    const runningLeft = tasks
      .filter((t) => t.status === 'running' && t.started_at)
      .reduce((acc, t) => acc + Math.max(0, mean - (now - new Date(t.started_at!).getTime())), 0)
    summary.etaMs = (summary.queued * mean + runningLeft) / parallel
  }
  return summary
}
