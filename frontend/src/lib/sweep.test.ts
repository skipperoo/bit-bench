import { describe, expect, it } from 'vitest'
import { chunkLabel, detectSweep } from './sweep'
import { paretoFront } from './pareto'
import type { Benchmark, DatasetSource } from '@/types'

function b(id: string, source?: Partial<DatasetSource>): Benchmark {
  return {
    id, name: id, user_id: 'u', original_filename: 'x', file_size: 1, file_checksum: 'c', file_ext: 'dataset',
    status: 'ready', compressors: [], created_at: '',
    source: source ? { kind: 'dataset', dataset: 'w', series: ['a'], chunk_size: 768, max_chunks: 10, transform: 'std', inputs: 10, ...source } : undefined,
  }
}

describe('detectSweep', () => {
  it('groups chunk sizes per transform with the whole series last', () => {
    const sweep = detectSweep([
      b('1', { chunk_size: 4096 }), b('2', { chunk_size: 0 }), b('3', { chunk_size: 768 }),
      b('4', { chunk_size: 768, transform: 'gap' }),
    ])!
    expect(sweep.chunkSizes).toEqual([768, 4096, 0])
    expect(sweep.transforms).toEqual(['gap', 'std'])
    expect(sweep.byTransform.get('std')!.map((p) => p.benchmark.id)).toEqual(['3', '1', '2'])
  })

  it('needs one dataset and two sizes of one transform', () => {
    expect(detectSweep([b('1'), b('2', { transform: 'gap' })])).toBeNull()
    expect(detectSweep([b('1'), b('2', { chunk_size: 256, dataset: 'other' })])).toBeNull()
    expect(detectSweep([b('1'), b('2')])).toBeNull()
    expect(detectSweep([b('1'), b('2', undefined)])).toBeNull()
  })

  it('labels chunk sizes', () => {
    expect([chunkLabel(0), chunkLabel(768), chunkLabel(4096)]).toEqual(['whole', '768', '4Ki'])
  })
})

describe('paretoFront', () => {
  it('keeps non-dominated points (min x, max y)', () => {
    const pts = [{ x: 3, y: 10 }, { x: 1, y: 2 }, { x: 2, y: 1 }, { x: 4, y: 5 }, { x: 2, y: 8 }]
    expect(paretoFront(pts)).toEqual([{ x: 1, y: 2 }, { x: 2, y: 8 }, { x: 3, y: 10 }])
  })
})
