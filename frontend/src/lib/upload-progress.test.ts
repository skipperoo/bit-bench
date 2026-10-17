import { describe, expect, it } from 'vitest'
import { batchFileStatuses, cumulativeBytes, sequentialFileStatuses, totalFileBytes } from './upload-progress'

const files = [{ size: 100 }, { size: 100 }, { size: 100 }]

describe('cumulativeBytes / totalFileBytes', () => {
  it('computes end offsets and totals', () => {
    expect(cumulativeBytes(files)).toEqual([100, 200, 300])
    expect(totalFileBytes(files)).toBe(300)
  })

  it('ignores negative sizes defensively', () => {
    expect(cumulativeBytes([{ size: -5 }, { size: 10 }])).toEqual([0, 10])
  })
})

describe('batchFileStatuses', () => {
  it('marks everything ready before the upload', () => {
    expect(batchFileStatuses(files, 'idle', 0, 0)).toEqual(['ready', 'ready', 'ready'])
  })

  it('ticks files once their bytes have been sent', () => {
    // 50% of the body sent → the first file is complete, the second is half way.
    expect(batchFileStatuses(files, 'uploading', 150, 300)).toEqual(['sent', 'uploading', 'uploading'])
    expect(batchFileStatuses(files, 'uploading', 300, 300)).toEqual(['sent', 'sent', 'sent'])
  })

  it('keeps earlier ticks when progress arrives in order', () => {
    expect(batchFileStatuses(files, 'uploading', 250, 300)).toEqual(['sent', 'sent', 'uploading'])
  })

  it('marks every file as processing once the transfer completes', () => {
    expect(batchFileStatuses(files, 'processing', 300, 300)).toEqual(['processing', 'processing', 'processing'])
  })

  it('falls back to uploading when the total size is unknown', () => {
    expect(batchFileStatuses(files, 'uploading', 10, 0)).toEqual(['uploading', 'uploading', 'uploading'])
  })

  it('reports final outcomes', () => {
    expect(batchFileStatuses(files, 'done', 300, 300)).toEqual(['done', 'done', 'done'])
    expect(batchFileStatuses(files, 'error', 0, 0)).toEqual(['error', 'error', 'error'])
  })

  it('handles empty files without getting stuck', () => {
    expect(batchFileStatuses([{ size: 0 }, { size: 100 }], 'uploading', 10, 200)).toEqual(['sent', 'uploading'])
  })
})

describe('sequentialFileStatuses', () => {
  it('keeps everything ready before the run', () => {
    expect(sequentialFileStatuses(3, 0, 'idle')).toEqual(['ready', 'ready', 'ready'])
  })

  it('shows the active file uploading and earlier files done', () => {
    expect(sequentialFileStatuses(3, 1, 'uploading')).toEqual(['done', 'uploading', 'ready'])
    expect(sequentialFileStatuses(3, 1, 'processing')).toEqual(['done', 'processing', 'ready'])
  })

  it('marks the active file done between requests', () => {
    expect(sequentialFileStatuses(3, 1, 'done')).toEqual(['done', 'done', 'ready'])
  })

  it('marks the active file failed and leaves the rest ready', () => {
    expect(sequentialFileStatuses(3, 1, 'error')).toEqual(['done', 'error', 'ready'])
  })
})
