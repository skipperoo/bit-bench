import { describe, it, expect } from 'vitest'
import SparkMD5 from 'spark-md5'

describe('MD5 computation', () => {
  it('computes correct MD5 for an empty file', async () => {
    const hash = SparkMD5.hash('')
    expect(hash).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('computes correct MD5 for a string', () => {
    const hash = SparkMD5.hash('hello world')
    expect(hash).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3')
  })

  it('computes correct MD5 for "BitBench"', () => {
    const hash = SparkMD5.hash('BitBench')
    expect(hash).toBe('d0d22e5a14911f55447018751afe0b2f')
  })

  it('produces 32-character hex string', () => {
    const hash = SparkMD5.hash('test data')
    expect(hash).toMatch(/^[a-f0-9]{32}$/)
  })
})

describe('computeMD5 function shape', () => {
  it('exports a function', async () => {
    const { computeMD5 } = await import('./md5')
    expect(typeof computeMD5).toBe('function')
  })
})
