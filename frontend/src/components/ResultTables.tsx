import { Button } from '@/components/ui/button'
import CompressorSwatch from '@/components/CompressorSwatch'
import SelfTestBadge from '@/components/SelfTestBadge'
import { renameCompressor } from '@/lib/compressors'
import { formatMetricValue, metricLabel } from '@/lib/format'
import { isLowerBetter } from '@/lib/metrics'
import { buildLatexTable, copyToClipboard } from '@/lib/latex'
import { downloadText, toCSV } from '@/lib/csv'
import { rankValues } from '@/lib/charts'

const rankClass = (rank: number) => (rank === 1 ? 'font-bold' : rank === 2 ? 'underline' : rank === 3 ? 'italic' : '')


function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function ExportButtons({ onLatex, onCsv }: { onLatex: () => void; onCsv: () => void }) {
  return (
    <div className="flex justify-end gap-2 mt-2">
      <Button variant="outline" size="sm" onClick={onCsv}>Download CSV</Button>
      <Button variant="outline" size="sm" onClick={onLatex}>Copy LaTeX</Button>
    </div>
  )
}

export interface RankedRow {
  compressor: string
  value: number
  reference?: number
  selfTestFailures?: number
}

/** One benchmark: compressors ranked by a metric (best bold, 2nd underlined, 3rd italic). */
export function RankedTable({ rows, metric, colors, shapes, referenceMetric, title }: {
  rows: RankedRow[]
  metric: string
  colors: Map<string, string>
  shapes?: Map<string, string>
  referenceMetric?: string
  title: string
}) {
  if (rows.length === 0) return null
  const lower = isLowerBetter(metric)
  const sorted = [...rows].sort((a, b) => (lower ? a.value - b.value : b.value - a.value))
  const ranks = rankValues(sorted.map((r) => r.value), lower)
  const hasRef = referenceMetric != null && sorted.some((r) => r.reference != null)
  const caption = `${metricLabel(metric)} — ${lower ? 'lower' : 'higher'} is better`
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 w-10">Rank</th>
              <th className="py-2">Compressor</th>
              <th className="py-2 text-right">{metricLabel(metric)}</th>
              {hasRef && <th className="py-2 text-right">{metricLabel(referenceMetric!)}</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.compressor} className="border-b border-border last:border-0">
                <td className="py-1 text-muted-foreground tabular-nums">{ranks[i]}</td>
                <td className={`py-1 font-mono ${rankClass(ranks[i] ?? 99)}`}>
                  <span className="inline-flex items-center gap-1.5">
                    <CompressorSwatch name={r.compressor} color={colors.get(r.compressor)} shape={shapes?.get(r.compressor)} />
                    {renameCompressor(r.compressor)}
                    <SelfTestBadge failures={r.selfTestFailures} />
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums font-mono">{formatMetricValue(r.value, metric)}</td>
                {hasRef && (
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {r.reference != null ? formatMetricValue(r.reference, referenceMetric!) : '–'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExportButtons
        onCsv={() => downloadText(`${slug(title)}-${metric}.csv`, toCSV(
          ['rank', 'compressor', metric, ...(hasRef ? [referenceMetric!] : []), 'self_test_failures'],
          sorted.map((r, i) => [ranks[i], r.compressor, r.value, ...(hasRef ? [r.reference ?? null] : []), r.selfTestFailures ?? 0]),
        ))}
        onLatex={() => copyToClipboard(buildLatexTable(
          sorted.map((r) => ({
            label: renameCompressor(r.compressor),
            values: [metric === 'compression_ratio' ? +(r.value * 100).toFixed(2) : r.value, ...(hasRef ? [r.reference ?? null] : [])],
          })),
          [metricLabel(metric), ...(hasRef ? [metricLabel(referenceMetric!)] : [])],
          caption,
          lower,
        ))}
      />
    </div>
  )
}

/**
 * Several benchmarks: rows = benchmarks (+ average), columns = compressors,
 * ranked per row like the report tables.
 */
export function ComparisonTable({ benchmarks, compressors, value, metric, colors, shapes }: {
  benchmarks: { id: string; name: string }[]
  compressors: string[]
  value: (benchmarkId: string, compressor: string) => number | null
  metric: string
  colors: Map<string, string>
  shapes?: Map<string, string>
}) {
  if (compressors.length === 0) return null
  const lower = isLowerBetter(metric)
  const rows = benchmarks.map((b) => ({ label: b.name, values: compressors.map((c) => value(b.id, c)) }))
  const average = {
    label: 'Average',
    values: compressors.map((_, ci) => {
      const vals = rows.map((r) => r.values[ci]).filter((v): v is number => v != null)
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    }),
  }
  const all = [...rows, average]
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th className="text-left p-2 font-medium">Benchmark</th>
              {compressors.map((c) => (
                <th key={c} className="text-right p-2 font-mono text-xs font-medium">
                  <span className="inline-flex items-center gap-1 justify-end">
                    <CompressorSwatch name={c} color={colors.get(c)} shape={shapes?.get(c)} />{renameCompressor(c)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {all.map((row, ri) => {
              const ranks = rankValues(row.values, lower)
              return (
                <tr key={ri} className={`border-b border-border ${ri === all.length - 1 ? 'font-semibold border-t-2' : ''}`}>
                  <td className="p-2 text-xs">{row.label}</td>
                  {row.values.map((v, ci) => (
                    <td key={ci} className={`text-right p-2 tabular-nums font-mono text-xs ${v == null ? 'text-muted-foreground' : rankClass(ranks[ci] ?? 99)}`}>
                      {v == null ? '–' : formatMetricValue(v, metric)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ExportButtons
        onCsv={() => downloadText(`comparison-${metric}.csv`, toCSV(['benchmark', ...compressors], all.map((r) => [r.label, ...r.values])))}
        onLatex={() => copyToClipboard(buildLatexTable(
          metric === 'compression_ratio'
            ? all.map((r) => ({ ...r, values: r.values.map((v) => (v == null ? null : +(v * 100).toFixed(2))) }))
            : all,
          compressors.map((c) => renameCompressor(c)),
          `${metricLabel(metric)} — ${lower ? 'lower' : 'higher'} is better`,
          lower,
        ))}
      />
    </div>
  )
}
