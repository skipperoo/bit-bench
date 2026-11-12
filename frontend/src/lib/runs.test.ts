import { describe, expect, it } from 'vitest'
import { summarizeTasks } from './runs'
import type { TaskView } from './runs'

const t = (seq: number, status: TaskView['status'], start?: number, end?: number): TaskView => ({
  seq, kind: 'builtin', compressor: 'built-in compressors', input: `x_${seq}.bin`, workers: 1, status,
  started_at: start != null ? new Date(start).toISOString() : undefined,
  finished_at: end != null ? new Date(end).toISOString() : undefined,
})

describe('summarizeTasks', () => {
  it('counts states and estimates the remaining time', () => {
    const now = 100_000
    const s = summarizeTasks([
      t(1, 'done', 0, 10_000), t(2, 'done', 0, 30_000),     // mean 20s
      t(3, 'running', now - 5_000), t(4, 'running', now - 25_000), // 15s + 0s left
      t(5, 'queued'), t(6, 'queued'),                       // 2 × 20s
    ], now)
    expect([s.total, s.done, s.running, s.queued, s.failed]).toEqual([6, 2, 2, 2, 0])
    expect(s.meanTaskMs).toBe(20_000)
    expect(s.etaMs).toBe((40_000 + 15_000) / 2)
  })

  it('has no ETA before any task finished', () => {
    expect(summarizeTasks([t(1, 'running', 0), t(2, 'queued')]).etaMs).toBeUndefined()
  })
})
