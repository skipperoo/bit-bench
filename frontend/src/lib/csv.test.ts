import { describe, expect, it } from 'vitest'
import { toCSV } from './csv'

describe('toCSV', () => {
  it('quotes separators, quotes and newlines; empties nulls', () => {
    expect(toCSV(['a', 'b'], [['x,y', 'say "hi"'], [1, null]])).toBe('a,b\n"x,y","say ""hi"""\n1,\n')
  })
})
