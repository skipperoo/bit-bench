import { describe, expect, it } from 'vitest'
import { getCompressorColor, getCompressorShape, renameCompressor, splitCompressorLabel } from './compressors'

describe('splitCompressorLabel', () => {
  it('splits a labelled compressor', () => {
    expect(splitCompressorLabel('gzip · level 9')).toEqual({ base: 'gzip', config: 'level 9' })
  })

  it('handles names without a label', () => {
    expect(splitCompressorLabel('gorilla')).toEqual({ base: 'gorilla', config: '' })
  })
})

describe('renameCompressor with labels', () => {
  it('renames the base and keeps the configuration', () => {
    expect(renameCompressor('gzip · level 9')).toBe('Gzip · level 9')
  })

  it('renames plain names as before', () => {
    expect(renameCompressor('neats')).toBe('NeaTS')
  })

  it('keeps unknown compressors untouched', () => {
    expect(renameCompressor('my_pkg · mode fast')).toBe('my_pkg · mode fast')
  })
})

describe('colors and shapes with labels', () => {
  it('derives the color from the base compressor', () => {
    expect(getCompressorColor('gzip · level 9')).toBe(getCompressorColor('gzip'))
  })

  it('derives the shape from the base family', () => {
    expect(getCompressorShape('gzip · level 9')).toBe(getCompressorShape('gzip'))
  })
})
