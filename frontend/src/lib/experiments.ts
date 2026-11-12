import type { Benchmark } from '@/types'
import type { BenchmarkStatus } from '@/lib/status'
import { describeSource } from '@/lib/datasets'
import { formatBytes } from '@/lib/format'

/** Most benchmarks one experiment view loads (a full dataset sweep). */
export const VIEW_LIMIT = 32

export function viewPath(ids: string[]): string {
  return `/experiments/view?ids=${ids.join(',')}`
}

/** One-line description of a benchmark's inputs (upload or dataset run). */
export function dataSourceText(b: Benchmark): string {
  if (b.source) return describeSource(b)
  const parts = [`${formatBytes(b.file_size)} · ${b.file_ext}`]
  if (b.file_count && b.file_count > 1) parts.push(`${b.file_count} files`)
  if (b.aggregation && b.aggregation !== 'mean') parts.push(`${b.aggregation} aggregation`)
  return parts.join(' · ')
}

/** One submission: a single upload, a "separate benchmarks" upload or a dataset run. */
export interface Experiment {
  id: string
  name: string
  benchmarks: Benchmark[]
  status: BenchmarkStatus
  createdAt: string
  /** Wall time from the first start to the last finish, when known (ms). */
  durationMs?: number
}

/**
 * Common base name of an experiment's benchmarks: "wild · std · 768" and
 * "wild · gap · 768" -> "wild"; "run (a)" and "run (b)" -> "run".
 */
export function experimentName(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  let prefix = names[0]
  for (const n of names.slice(1)) {
    let i = 0
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++
    prefix = prefix.slice(0, i)
  }
  const trimmed = prefix.replace(/[\s·(\-_]+$/u, '').trim()
  return trimmed || names[0]
}

/** Status of a group: active if any member runs, failed if any failed, … */
export function aggregateStatus(statuses: BenchmarkStatus[]): BenchmarkStatus {
  if (statuses.includes('in_progress')) return 'in_progress'
  if (statuses.includes('queued')) return 'queued'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('timed_out')) return 'timed_out'
  if (statuses.length > 0 && statuses.every((s) => s === 'cancelled')) return 'cancelled'
  return 'ready'
}

export function benchmarkDurationMs(b: Benchmark): number | undefined {
  if (!b.started_at || !b.finished_at) return undefined
  return Math.max(0, new Date(b.finished_at).getTime() - new Date(b.started_at).getTime())
}

/** Groups benchmarks by experiment, keeping the list order (newest first). */
export function groupExperiments(benchmarks: Benchmark[]): Experiment[] {
  const order: string[] = []
  const groups = new Map<string, Benchmark[]>()
  for (const b of benchmarks) {
    const key = b.experiment_id || b.id
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(b)
  }
  return order.map((id) => {
    const members = groups.get(id)!
    const starts = members.map((b) => b.started_at).filter(Boolean).map((t) => new Date(t!).getTime())
    const ends = members.map((b) => b.finished_at).filter(Boolean).map((t) => new Date(t!).getTime())
    const status = aggregateStatus(members.map((b) => b.status))
    const done = ends.length === members.length && starts.length > 0
    return {
      id,
      name: experimentName(members.map((b) => b.name)),
      benchmarks: members,
      status,
      createdAt: members.reduce((min, b) => (b.created_at < min ? b.created_at : min), members[0].created_at),
      durationMs: done ? Math.max(...ends) - Math.min(...starts) : undefined,
    }
  })
}

export function formatDuration(ms?: number): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Data-source line of a whole experiment (dataset runs list their spread). */
export function experimentSourceText(benchmarks: Benchmark[]): string {
  if (benchmarks.length === 1 || !benchmarks.every((b) => b.source)) return dataSourceText(benchmarks[0])
  const first = benchmarks[0].source!
  const transforms = [...new Set(benchmarks.map((b) => b.source!.transform))].sort()
  const sizes = [...new Set(benchmarks.map((b) => b.source!.chunk_size))].sort((a, b) => a - b)
  const chunks = sizes.map((n) => (n === 0 ? 'whole' : n.toLocaleString())).join(', ')
  return `${first.dataset} (${first.series.length} series) · ${transforms.join(', ')} · ${chunks} samples · ${benchmarks.length} benchmarks`
}
