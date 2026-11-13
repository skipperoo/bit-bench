import { describe, expect, it } from 'vitest'
import { aggregateStatus, experimentName, formatDuration, groupExperiments, renameExperiment, rerunConfig } from './experiments'
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

describe('rerunConfig', () => {
  const src = (chunk_size: number, transform: 'std' | 'gap' = 'std') =>
    ({ kind: 'dataset' as const, dataset: 'wildppg', series: ['ecg', 'ppg'], chunk_size, max_chunks: 10, transform, inputs: 20 })
  const gzip = [{ name: 'gzip', options: { level: 9 }, label: 'gzip · level 9' }]

  it('rebuilds a dataset run with every chunk size and transform', () => {
    const cfg = rerunConfig([
      b('1', 'sweep · std · 16384', { experiment_id: 'e', source: src(16384), compressors: gzip, aggregation: 'pooled', measure_memory: false }),
      b('2', 'sweep · std · 0', { experiment_id: 'e', source: src(0), compressors: gzip }),
      b('3', 'sweep · gap · 1024', { experiment_id: 'e', source: src(1024, 'gap'), compressors: gzip }),
      b('4', 'sweep · std · 1024', { experiment_id: 'e', source: src(1024), compressors: gzip }),
    ])!
    expect(cfg.name).toBe('sweep')
    expect(cfg.source).toEqual({ dataset: 'wildppg', series: ['ecg', 'ppg'], max_chunks: 10, chunk_sizes: [1024, 16384, 0], transforms: ['std', 'gap'] })
    expect(cfg.compressors).toEqual([{ name: 'gzip', options: { level: 9 } }])
    expect([cfg.aggregation, cfg.measureMemory]).toEqual(['pooled', false])
  })

  it('keeps the name of a one-size run and handles uploads', () => {
    expect(rerunConfig([b('1', 'solo · std · 768', { experiment_id: 'e', source: src(768) })])!.name).toBe('solo')
    const upload = rerunConfig([b('1', 'run (a)', { experiment_id: 'u' }), b('2', 'run (b)', { experiment_id: 'u' })])!
    expect(upload.name).toBe('run')
    expect(upload.source).toBeUndefined()
  })

  it('needs the benchmarks of a single experiment', () => {
    expect(rerunConfig([])).toBeNull()
    expect(rerunConfig([b('1', 'a', { experiment_id: 'x' }), b('2', 'b', { experiment_id: 'y' })])).toBeNull()
  })
})

describe('renameExperiment', () => {
  const b = (id: string, name: string) => ({ id, name, experiment_id: 'e' }) as unknown as Benchmark
  it('replaces the shared name and keeps each suffix', () => {
    const [exp] = groupExperiments([b('1', 'WildPPG1 · std · 768'), b('2', 'WildPPG1 · gap · whole')])
    expect(renameExperiment(exp, 'wildPPG2')).toEqual([
      { id: '1', name: 'wildPPG2 · std · 768' },
      { id: '2', name: 'wildPPG2 · gap · whole' },
    ])
  })
  it('renames a single benchmark entirely', () => {
    const [exp] = groupExperiments([{ ...b('3', 'one'), experiment_id: undefined }])
    expect(renameExperiment(exp, 'two')).toEqual([{ id: '3', name: 'two' }])
  })
})
