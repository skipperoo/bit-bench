// LaTeX table generator — mirrors scripts/generate_full_html_report.py formatting

export interface LatexTableColumn {
  name: string
  values: (number | null)[]  // one per row
}

export interface LatexTableRow {
  label: string
  values: (number | null)[]
}

/**
 * Build a LaTeX table from rows × columns of data.
 * @param rows - list of row labels and their values (one per column)
 * @param columns - column header names
 * @param caption - optional table caption
 * @param lowerIsBetter - if true, rank-1 = lowest value (bold), rank-2 = underline, rank-3 = italic
 */
export function buildLatexTable(
  rows: LatexTableRow[],
  columns: string[],
  caption: string,
  lowerIsBetter: boolean,
): string {
  const numCols = columns.length
  const colSpec = `l${'r'.repeat(numCols)}`

  const lines: string[] = []
  lines.push('% BitBench LaTeX table — auto-generated')
  lines.push(`\\\\begin{table}[htbp]`)
  lines.push(`  \\\\centering`)
  lines.push(`  \\\\caption{${escapeLatex(caption)}}`)
  lines.push(`  \\\\begin{tabular}{${colSpec}}`)
  lines.push(`    \\\\toprule`)
  lines.push(`    Dataset & ${columns.map((c) => escapeLatex(c)).join(' & ')} \\\\\\\\`)
  lines.push(`    \\\\midrule`)

  for (const row of rows) {
    const cellTexts = row.values.map((v, ci) => {
      if (v == null) return '-'
      return formatLatexCell(v, row.values, ci, lowerIsBetter)
    })
    lines.push(`    ${escapeLatex(row.label)} & ${cellTexts.join(' & ')} \\\\\\\\`)
  }

  lines.push(`    \\\\bottomrule`)
  lines.push(`  \\\\end{tabular}`)

  if (caption) {
    const dir = lowerIsBetter ? 'Lower is better' : 'Higher is better'
    lines.push(`  \\\\small{${escapeLatex(dir)}. Bold = best, underline = 2nd, italic = 3rd.}`)
  }

  lines.push(`\\\\end{table}`)

  return lines.join('\\n')
}

function formatLatexCell(value: number, allValues: (number | null)[], _colIndex: number, lowerIsBetter: boolean): string {
  const valid = allValues.filter((v): v is number => v != null)
  const sorted = [...valid].sort((a, b) => lowerIsBetter ? a - b : b - a)
  const rank = sorted.indexOf(value)

  const formatted = formatLatexNumber(value)

  if (rank === 0) return `\\\\textbf{${formatted}}`
  if (rank === 1) return `\\\\underline{${formatted}}`
  if (rank === 2) return `\\\\emph{${formatted}}`
  return formatted
}

function formatLatexNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 10000) return value.toString()
  return value.toFixed(4)
}

function escapeLatex(text: string): string {
  return text
    .replace(/\\\\/g, '\\\\textbackslash ')
    .replace(/&/g, '\\\\&')
    .replace(/%/g, '\\\\%')
    .replace(/\\$/g, '\\\\$')
    .replace(/#/g, '\\\\#')
    .replace(/_/g, '\\\\_')
    .replace(/\\{/g, '\\\\{')
    .replace(/\\}/g, '\\\\}')
    .replace(/~/g, '\\\\textasciitilde ')
    .replace(/\\^/g, '\\\\textasciicircum ')
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}
