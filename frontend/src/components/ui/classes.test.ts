import { describe, expect, it } from 'vitest'
import themeCss from '@/index.css?raw'

// Source of every UI primitive, so a broken utility class (e.g. `bg-background-lg`
// left behind by a bad search-and-replace) fails the suite instead of silently
// rendering an invisible switch thumb or an unstyled button.
const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const themeColors = new Set([...themeCss.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]))
const keywords = new Set(['transparent', 'current', 'inherit', 'white', 'black'])
// Non-colour values of the same prefixes (sizes, widths, alignment).
const nonColor = /^(xs|sm|base|lg|xl|[2-9]xl|left|right|center|justify|start|end|0|1|2|4|8|x|y|t|b|l|r|offset-\d+|inset|none|solid|dashed|dotted|collapse|separate|clip)$/

function colourTokens(source: string): string[] {
  const strings = [...source.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])
  return strings
    .flatMap((s) => s.split(/\s+/))
    .map((t) => t.split(':').pop() ?? '')
    .filter((t) => /^(bg|text|border|ring|ring-offset|fill|stroke)-/.test(t))
}

describe('UI primitive classes', () => {
  it('found the primitives and the theme', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3)
    expect(themeColors.has('background')).toBe(true)
  })

  for (const [file, source] of Object.entries(sources)) {
    it(`${file} only uses theme colours`, () => {
      const bad = colourTokens(source).filter((token) => {
        const value = token.replace(/^(ring-offset|bg|text|border|ring|fill|stroke)-/, '').replace(/\/\d+$/, '')
        if (nonColor.test(value) || keywords.has(value)) return false
        if (/^(t|b|l|r|x|y)-/.test(value)) return false // border-t-*, etc.
        if (/^[a-z]+-\d{2,3}$/.test(value)) return false // Tailwind palette (red-600)
        return !themeColors.has(value)
      })
      expect(bad).toEqual([])
    })
  }
})
