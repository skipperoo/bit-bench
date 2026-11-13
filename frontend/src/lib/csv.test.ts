import { describe, expect, it } from 'vitest'
import { allResultsCSV, toCSV } from './csv'
import type { Benchmark, BenchmarkResult } from '@/types'

describe('toCSV', () => {
  it('quotes separators, quotes and newlines; empties nulls', () => {
    expect(toCSV(['a', 'b'], [['x,y', 'say "hi"'], [1, null]])).toBe('a,b\n"x,y","say ""hi"""\n1,\n')
  })
})

describe('allResultsCSV', () => {
  it('writes one row per benchmark and compressor with every metric', () => {
    const b = (id: string, chunk: number) => ({
      id, name: `wild · std · ${chunk}`, original_filename: 'wildppg',
      source: { kind: 'dataset', dataset: 'wildppg', series: ['a'], chunk_size: chunk, max_chunks: 0, transform: 'std', inputs: 1 },
    }) as unknown as Benchmark
    const r = (compressor: string, extra: Partial<BenchmarkResult>) => ({ id: compressor, benchmark_id: '', compressor, dataset: '', ...extra }) as BenchmarkResult
    const csv = allResultsCSV([
      { benchmark: b('1', 768), results: [r('gzip', { compression_ratio: 0.5, range_queries: { '10': 3 } })] },
      { benchmark: b('2', 0), results: [r('b_gef_optimal', { compression_ratio: 0.25, memory_usage: 1024 })] },
    ])
    const [header, first, second] = csv.trim().split('\n')
    expect(header).toBe('benchmark,dataset,transform,chunk_size,aggregation,compressor,label,num_values,original_size,uncompressed_bits,compressed_bits,input_buffer,self_test_failures,compression_ratio,memory_usage,range_query_10')
    expect(first).toBe('wild · std · 768,wildppg,std,768,mean,Gzip,gzip,,,,,,,0.5,,3')
    expect(second).toBe('wild · std · 0,wildppg,std,0,mean,B-GEF (Opt),b_gef_optimal,,,,,,,0.25,1024,')
  })
})
