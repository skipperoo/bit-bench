import { describe, expect, it } from 'vitest'
import { aggregateStatus, experimentName, formatDuration, groupExperiments } from './experiments'
import type { Benchmark } from '@/types'

function b(id: string, name: string, extra: Partial<Benchmark> = {}): Benchmark {
  return {
    id, name, user_id: 'u', original_filename: 'x', file_size: 1, file_checksum: 'c', file_ext: 'bin',
    status: 'ready', compressors: [], created_at: '2026-11-12T10:00:00Z', ...extra,
  }
}

describe('experiments', () => {
  it('derives a common name', () => {
    expect(experimentName(['wild · std · 768', 'wild · gap · 768'])).toBe('wild')
    expect(experimentName(['run (a)', 'run (b)'])).toBe('run')
    expect(experimentName(['solo'])).toBe('solo')
    expect(experimentName(['abc', 'xyz'])).toBe('abc')
  })

  it('aggregates statuses with active and failed states first', () => {
    expect(aggregateStatus(['ready', 'in_progress'])).toBe('in_progress')
    expect(aggregateStatus(['ready', 'failed'])).toBe('failed')
    expect(aggregateStatus(['cancelled', 'cancelled'])).toBe('cancelled')
    expect(aggregateStatus(['ready', 'cancelled'])).toBe('ready')
  })

  it('groups by experiment id in list order and computes the wall time', () => {
    const groups = groupExperiments([
      b('1', 'wild · std · 768', { experiment_id: 'e', started_at: '2026-11-12T10:00:00Z', finished_at: '2026-11-12T10:01:00Z' }),
      b('2', 'wild · gap · 768', { experiment_id: 'e', started_at: '2026-11-12T10:00:30Z', finished_at: '2026-11-12T10:03:00Z' }),
      b('3', 'other'),
    ])
    expect(groups.map((g) => [g.id, g.name, g.benchmarks.length])).toEqual([['e', 'wild', 2], ['3', 'other', 1]])
    expect(groups[0].durationMs).toBe(180_000)
    expect(groups[1].durationMs).toBeUndefined()
  })

  it('formats durations', () => {
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(185_000)).toBe('3m 5s')
    expect(formatDuration(undefined)).toBe('—')
  })
})
