import { describe, expect, it } from 'vitest'
import { checkUploadFiles } from './files'

function file(name: string, size: number): File {
  return new File([new Uint8Array(size)], name)
}

describe('checkUploadFiles', () => {
  it('accepts allowed extensions case-insensitively', () => {
    const { accepted, rejected } = checkUploadFiles([file('a.BIN', 24), file('b.csv', 3), file('c.zip', 5), file('d.tar', 5)], 1)
    expect(accepted).toHaveLength(4)
    expect(rejected).toEqual([])
  })

  it('rejects unknown types, oversized and empty files', () => {
    const { accepted, rejected } = checkUploadFiles([file('a.txt', 3), file('big.bin', 2 * 1024 * 1024), file('e.bin', 0)], 1)
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(3)
    expect(rejected[1]).toContain('larger than 1 MB')
  })

  it('treats a zero limit as unlimited', () => {
    expect(checkUploadFiles([file('big.bin', 5 * 1024 * 1024)], 0).accepted).toHaveLength(1)
  })
})
