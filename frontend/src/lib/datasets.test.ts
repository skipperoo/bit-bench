import { describe, expect, it } from 'vitest'
import { chunkCount, describeChunking, plannedChunks, planRuns, WHOLE_SERIES } from './datasets'

describe('chunk planning', () => {
  it('discards the trailing partial chunk and caps by max chunks', () => {
    expect(chunkCount(1000, 300)).toBe(3)
    expect(chunkCount(1000, WHOLE_SERIES)).toBe(1)
    expect(plannedChunks(10_000, 768, 10)).toBe(10)
    expect(plannedChunks(10_000, 768, 0)).toBe(13)
  })

  it('plans one run per (transform, unique chunk size) and reports skipped series', () => {
    const series = [
      { name: 'long', values: 100_000, decimals: 0, size_bytes: 0 },
      { name: 'short', values: 500, decimals: 0, size_bytes: 0 },
    ]
    const runs = planRuns(series, [4096, 0, 4096], 10, ['std', 'gap'])
    expect(runs.map((r) => [r.transform, r.chunkSize, r.inputs])).toEqual([
      ['std', 0, 2], ['std', 4096, 10], ['gap', 0, 2], ['gap', 4096, 10],
    ])
    expect(runs[1].skipped).toEqual(['short'])
  })

  it('describes chunking', () => {
    expect(describeChunking(0, 10)).toBe('whole series')
    expect(describeChunking(768, 10)).toBe('768 samples × ≤10')
  })
})
