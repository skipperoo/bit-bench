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

describe('custom coders and configuration shades', () => {
  it('puts user packages in the Custom family with the cross marker', async () => {
    const { getCompressorFamily, isBuiltinCompressor } = await import('./compressors')
    expect(isBuiltinCompressor('gzip · level 9')).toBe(true)
    expect(isBuiltinCompressor('pfordelta_newpfor')).toBe(true)
    expect(isBuiltinCompressor('my_codec')).toBe(false)
    expect(getCompressorFamily('my_codec · mode fast')).toBe('Custom')
    expect(getCompressorShape('my_codec')).toBe('cross')
  })

  it('gives custom coders a stable colour from their own palette', async () => {
    const { CUSTOM_PALETTE, COMPRESSOR_COLORS } = await import('./compressors')
    const c = getCompressorColor('my_codec')
    expect(CUSTOM_PALETTE).toContain(c)
    expect(getCompressorColor('my_codec · level 3')).toBe(c)
    expect(Object.values(COMPRESSOR_COLORS)).not.toContain(c)
  })

  it('honours spec.yaml colours', async () => {
    const { registerCompressorColors, packageColor } = await import('./compressors')
    registerCompressorColors({ branded: packageColor({ color: '#123ABC' }), ignored: 'red' })
    expect(getCompressorColor('branded')).toBe('#123abc')
    expect(getCompressorColor('ignored')).not.toBe('red')
  })

  it('shades further configurations of the same algorithm', async () => {
    const { assignCompressorColors } = await import('./compressors')
    const colors = assignCompressorColors(['gzip · level 9', 'gzip', 'gzip · level 1', 'zstd'])
    expect(colors.get('gzip')).toBe(getCompressorColor('gzip'))
    expect(colors.get('zstd')).toBe(getCompressorColor('zstd'))
    const shades = new Set([colors.get('gzip'), colors.get('gzip · level 1'), colors.get('gzip · level 9')])
    expect(shades.size).toBe(3)
  })

  it('names and groups the FastPFor codecs as PForDelta', async () => {
    const { getCompressorFamily } = await import('./compressors')
    expect(renameCompressor('pfordelta_newpfor')).toBe('PForDelta (newpfor)')
    expect(renameCompressor('pfordelta_simdnewpfor')).toBe('PForDelta')
    expect(getCompressorFamily('pfordelta_optpfor')).toBe('PForDelta')
    expect(getCompressorShape('pfordelta_optpfor')).toBe('star')
  })
})

describe('assignCompressorStyles', () => {
  it('keeps the report colours and separates clashing colours by shape', async () => {
    const { assignCompressorStyles } = await import('./compressors')
    // Gzip, Gorilla and B*-GEF (Approx) all use #1f77b4 in the report palette.
    const styles = assignCompressorStyles(['gzip', 'gorilla', 'b_star_gef_approximate', 'zstd'])
    expect(styles.get('gzip')!.color).toBe(getCompressorColor('gzip'))
    expect(styles.get('gorilla')!.color).toBe(getCompressorColor('gzip'))
    const sameColour = ['gzip', 'gorilla', 'b_star_gef_approximate'].map((n) => styles.get(n)!.shape)
    expect(new Set(sameColour).size).toBe(3)
    expect(styles.get('zstd')!.shape).toBe(getCompressorShape('zstd'))
  })

  it('changes a shape only when it would repeat within one colour', async () => {
    const { assignCompressorStyles } = await import('./compressors')
    // ALP (circle) and U-GEF (Opt) (triangle) share a colour but not a shape.
    const styles = assignCompressorStyles(['alp', 'u_gef_optimal'])
    expect(styles.get('alp')!.shape).toBe('circle')
    expect(styles.get('u_gef_optimal')!.shape).toBe('triangle-up')
    // Two time-series coders with the same colour: Gorilla keeps its circle,
    // the other gets an alternate shape.
    const ts = assignCompressorStyles(['gorilla', 'chimp128', 'zstd', 'u_gef_approximate'])
    const pink = ['chimp128', 'zstd', 'u_gef_approximate'].map((n) => ts.get(n)!)
    expect(new Set(pink.map((p) => p.color)).size).toBe(1)
    expect(new Set(pink.map((p) => p.shape)).size).toBe(3)
  })

  it('applies the user overrides and keeps the other shapes distinct', async () => {
    const { assignCompressorStyles } = await import('./compressors')
    // gzip normally keeps its diamond; the override takes it for Gorilla.
    const styles = assignCompressorStyles(['gzip', 'Gorilla', 'b_star_gef_approximate'], { shapes: { gorilla: 'diamond' } })
    expect(styles.get('Gorilla')!.shape).toBe('diamond')
    const shapes = ['gzip', 'Gorilla', 'b_star_gef_approximate'].map((n) => styles.get(n)!.shape)
    expect(new Set(shapes).size).toBe(3)
    // Unknown shapes are ignored.
    expect(assignCompressorStyles(['zstd'], { shapes: { zstd: 'blob' } }).get('zstd')!.shape).toBe(getCompressorShape('zstd'))
  })

  it('applies colour overrides and separates the new colour clash by shape', async () => {
    const { assignCompressorStyles } = await import('./compressors')
    // Zstd (diamond) recoloured to gzip's blue: same colour and same family
    // shape, so one of them must get another shape.
    const styles = assignCompressorStyles(['gzip', 'zstd'], { colors: { zstd: '#1F77B4' } })
    expect(styles.get('zstd')!.color).toBe('#1f77b4')
    expect(styles.get('gzip')!.color).toBe(getCompressorColor('gzip'))
    expect(styles.get('gzip')!.shape).not.toBe(styles.get('zstd')!.shape)
    // Invalid colours are ignored.
    expect(assignCompressorStyles(['zstd'], { colors: { zstd: 'red' } }).get('zstd')!.color).toBe(getCompressorColor('zstd'))
  })
})
