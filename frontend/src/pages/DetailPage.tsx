import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ScatterChart, Scatter, ResponsiveContainer, Cell, type LabelProps
} from 'recharts'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { renameCompressor, getCompressorColor, getCompressorShape } from '@/lib/compressors'
import { formatMetricValue } from '@/lib/format'
import { buildLatexTable, copyToClipboard } from '@/lib/latex'
import type { LatexTableRow } from '@/lib/latex'
import type { Benchmark, BenchmarkResult, BenchmarkDetailResponse } from '@/types'


function getYLabel(metric: string): LabelProps {
  return { 
    value: metricLabel(metric), 
    angle: -90, 
    position: 'insideLeft', 
    offset: 5,
    style: { textAnchor: 'middle' }
  }
}

const chartMargins = { left: 20, right: 20, top: 20, bottom: 120 }

// Render a compressor marker as raw SVG element (used inside Recharts SVG context)
function CompressorShapeSVG({ cx, cy, name }: { cx: number; cy: number; name: string }) {
  const shape = getCompressorShape(name)
  const color = getCompressorColor(name)
  const r = 6
  switch (shape) {
    case 'square':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={color} />
    case 'diamond':
      return <polygon points={`${cx},${cy - r * 1.4} ${cx + r * 1.4},${cy} ${cx},${cy + r * 1.4} ${cx - r * 1.4},${cy}`} fill={color} />
    case 'triangle-up':
      return <polygon points={`${cx},${cy - r * 1.5} ${cx + r * 1.4},${cy + r} ${cx - r * 1.4},${cy + r}`} fill={color} />
    case 'star': {
      const pts = []
      for (let i = 0; i < 5; i++) {
        const a = (i * 4 * Math.PI) / 5 - Math.PI / 2
        pts.push(`${cx + r * 1.5 * Math.cos(a)},${cy + r * 1.5 * Math.sin(a)}`)
      }
      return <polygon points={pts.join(' ')} fill={color} />
    }
    case 'pentagon': {
      const pts = []
      for (let i = 0; i < 5; i++) {
        const a = (i * 2 * Math.PI) / 5 - Math.PI / 2
        pts.push(`${cx + r * 1.3 * Math.cos(a)},${cy + r * 1.3 * Math.sin(a)}`)
      }
      return <polygon points={pts.join(' ')} fill={color} />
    }
    default:
      return <circle cx={cx} cy={cy} r={r} fill={color} />
  }
}

// Standalone marker for the legend (wrapped in <svg> so it renders in HTML context)
function LegendMarker({ name }: { name: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" className="shrink-0">
      <CompressorShapeSVG cx={7} cy={7} name={name} />
    </svg>
  )
}

// Shape renderer for Recharts scatter points
function CompressorShape(scatterProps: any) {
  const name = scatterProps.payload?.name || ''
  return <CompressorShapeSVG cx={scatterProps.cx} cy={scatterProps.cy} name={name} />
}

const LOWER_IS_BETTER = new Set([
  'compression_ratio', 'compressed_bits', 'uncompressed_bits',
  'original_size', 'memory_usage', 'compressor_internal', 'random_access_ns',
])

function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    compression_ratio: 'Compression Ratio (%)',
    compression_throughput_mbs: 'Compression Throughput (MB/s)',
    decompression_throughput_mbs: 'Decompression Throughput (MB/s)',
    memory_usage: 'Memory Usage',
    compressor_internal: 'Compressor Memory',
    random_access_ns: 'Random Access (ns)',
    random_access_mbs: 'Random Access (MB/s)',
  }
  return labels[key] || key
}

function isLowerBetter(key: string): boolean {
  return LOWER_IS_BETTER.has(key)
}

interface RankedRow {
  compressor: string
  value: number
  rank: number
}

function rankResults(results: BenchmarkResult[], metric: string): RankedRow[] {
  const rows: RankedRow[] = []
  for (const r of results) {
    const v = (r as any)[metric]
    if (v != null) {
      rows.push({ compressor: r.compressor, value: v, rank: 0 })
    }
  }
  const asc = !isLowerBetter(metric)
  rows.sort((a, b) => asc ? b.value - a.value : a.value - b.value)
  rows.forEach((r, i) => { r.rank = i + 1 })
  return rows
}

function ParetoBadge({ dominationCount }: { dominationCount: number }) {
  if (dominationCount === 0) {
    return <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Pareto-optimal</Badge>
  }
  return null
}

function computePareto(results: BenchmarkResult[]): Map<string, number> {
  const domCounts = new Map<string, number>()
  const valid = results.filter(
    (r) => r.compression_ratio != null && r.compression_throughput_mbs != null
  )
  if (valid.length === 0) return domCounts

  for (const a of valid) {
    let count = 0
    for (const b of valid) {
      if (a === b) continue
      const bDominatesA = b.compression_ratio! <= a.compression_ratio! &&
        b.compression_throughput_mbs! >= a.compression_throughput_mbs!
      const strictlyBetter = b.compression_ratio! < a.compression_ratio! ||
        b.compression_throughput_mbs! > a.compression_throughput_mbs!
      if (bDominatesA && strictlyBetter) {
        count++
      }
    }
    domCounts.set(a.compressor, count)
  }

  return domCounts
}

function OverviewBarChart({ results }: { results: BenchmarkResult[] }) {
  const data = results
    .filter((r) => r.compression_ratio != null)
    .map((r) => ({
      name: renameCompressor(r.compressor),
      compressor: r.compressor,
      ratio: +(r.compression_ratio! * 100).toFixed(2),
    }))

  if (data.length === 0) return <p className="text-sm text-muted-foreground">No data</p>

  return (
    <div className="h-[432px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={chartMargins}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
          <YAxis
            tickFormatter={(v: number) => v.toFixed(2)}
            width={80}
            label={getYLabel('Ratio (%)')}
          />
          <Tooltip formatter={(v: any) => v != null ? `${Number(v).toFixed(2)}%` : '-'} />
          <Bar dataKey="ratio" fill="#2563eb">
            {data.map((d) => (
              <Cell key={d.name} fill={getCompressorColor(d.compressor)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function MetricBarChart({ results, metric }: { results: BenchmarkResult[]; metric: string }) {
  const data = results
    .filter((r) => (r as any)[metric] != null)
    .map((r) => ({
      name: renameCompressor(r.compressor),
      compressor: r.compressor,
      [metric]: +((r as any)[metric]).toFixed(4),
    }))

  if (data.length === 0) return null
  const label = metricLabel(metric)

  return (
    <div className="h-[384px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={chartMargins}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
          <YAxis
            tickFormatter={(v: number) => formatMetricValue(v, metric)}
            width={100}
            label={getYLabel(label)}
          />
          <Tooltip formatter={(v: any) => formatMetricValue(v, metric)} />
          <Bar dataKey={metric} fill="#16a34a">
            {data.map((d) => (
              <Cell key={d.name} fill={getCompressorColor(d.compressor)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function ScatterChartMetric({ results, metric }: { results: BenchmarkResult[]; metric: string }) {
  const data = results
    .filter((r) => (r as any)[metric] != null && r.compression_ratio != null)
    .map((r) => ({
      x: +(r.compression_ratio! * 100).toFixed(2),
      y: +((r as any)[metric]).toFixed(2),
      name: renameCompressor(r.compressor),
    }))
    .sort((a, b) => a.x - b.x)

  if (data.length === 0) return null

  const xs = data.map((d) => d.x)
  const ys = data.map((d) => d.y)
  const xPad = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) * 0.05 || 1 : 1
  const yPad = ys.length > 1 ? (Math.max(...ys) - Math.min(...ys)) * 0.05 || 1 : 1
  const xDomain: [number, number] = [0, xs[xs.length - 1] + xPad]
  const yDomain: [number, number] = [0, Math.max(...ys) + yPad]

  return (
    <div>
      <div className="h-[480px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={chartMargins}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="x"
              name="Compression Ratio (%)"
              domain={xDomain}
              type="number"
              tickFormatter={(v: number) => v.toFixed(2)}
              label={{ value: 'Compression Ratio (%)', position: 'bottom', offset: 30 }}
            />
            <YAxis
              dataKey="y"
              name={metricLabel(metric)}
              domain={yDomain}
              type="number"
              width={80}
              tickFormatter={(v: number) => formatMetricValue(v, metric)}
              label={getYLabel(metric)}
            />
            <Tooltip
              content={<CustomScatterTooltip metric={metric}/>}   
            />
            <Scatter
              data={data}
              shape={CompressorShape}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={getCompressorColor(d.name)} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 justify-center -mt-4">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <LegendMarker name={d.name} />
            <span className="text-xs text-muted-foreground">{d.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RankedTable({ results, metric }: { results: BenchmarkResult[]; metric: string }) {
  const ranked = rankResults(results, metric)
  if (ranked.length === 0) return null

  // Build latex table data
  const latexRows: LatexTableRow[] = ranked.map((r) => ({
    label: renameCompressor(r.compressor),
    values: [r.value],
  }))
  const lowerIsBetter = isLowerBetter(metric)
  const rankLabel = lowerIsBetter ? 'Lower is better' : 'Higher is better'

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2">Rank</th>
              <th className="text-left py-2">Compressor</th>
              <th className="text-right py-2">{metricLabel(metric)}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.compressor} className="border-b last:border-0">
                <td className="py-1 text-muted-foreground w-8">{r.rank}</td>
                <td className={`py-1 font-mono ${
                  r.rank === 1 ? 'font-bold' : r.rank === 2 ? 'underline' : r.rank === 3 ? 'italic' : ''
                }`}>
                  {renameCompressor(r.compressor)}
                </td>
                <td className="text-right py-1">
                  {formatMetricValue(r.value, metric)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end mt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const latex = buildLatexTable(latexRows, [metricLabel(metric)], `${metricLabel(metric)} — ${rankLabel}`, lowerIsBetter)
            await copyToClipboard(latex)
          }}
        >
          Copy LaTeX
        </Button>
      </div>
    </div>
  )
}

export default function DetailPage() {
  const { id } = useParams<{ id: string }>()
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedMetric, setExpandedMetric] = useState<string | null>('compression_ratio')

  useEffect(() => {
    if (!id) return
    apiFetch<BenchmarkDetailResponse>(`/benchmarks/${id}`)
      .then((data) => {
        setBenchmark(data.benchmark)
        setResults(data.results || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <p className="text-muted-foreground">Loading...</p>
  if (!benchmark) return <p className="text-destructive">Benchmark not found</p>

  const paretoCounts = computePareto(results)
  const paretoSorted = [...paretoCounts.entries()]
    .sort((a, b) => a[1] - b[1] || (results.find(r => r.compressor === a[0])?.compression_ratio ?? 0) - (results.find(r => r.compressor === b[0])?.compression_ratio ?? 0))
    .slice(0, 5)

  const hasThroughput = results.some((r) => r.compression_throughput_mbs != null)
  const hasDecompression = results.some((r) => r.decompression_throughput_mbs != null)
  const hasMemory = results.some((r) => r.memory_usage != null)
  const hasCompressorInternal = results.some((r) => r.compressor_internal != null)
  const hasRandomNS = results.some((r) => r.random_access_ns != null)
  const hasRandomMBS = results.some((r) => r.random_access_mbs != null)

  const metricSections = [
    { key: 'compression_ratio', label: 'Compression Ratio', chart: 'bar' as const, show: true },
    { key: 'compression_throughput_mbs', label: 'Compression Throughput', chart: 'scatter' as const, show: hasThroughput },
    { key: 'decompression_throughput_mbs', label: 'Decompression Throughput', chart: 'scatter' as const, show: hasDecompression },
    { key: 'memory_usage', label: 'Memory Usage', chart: 'bar' as const, show: hasMemory },
    { key: 'compressor_internal', label: 'Compressor Memory', chart: 'bar' as const, show: hasCompressorInternal },
    { key: 'random_access_ns', label: 'Random Access (ns)', chart: 'bar' as const, show: hasRandomNS },
    { key: 'random_access_mbs', label: 'Random Access (MB/s)', chart: 'scatter' as const, show: hasRandomMBS },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{benchmark.name}</h1>
        <div className="flex items-center gap-2 mt-1">
          <Badge>{benchmark.status}</Badge>
          <span className="text-sm text-muted-foreground">
            {(benchmark.file_size / 1024).toFixed(1)} KB &middot; {benchmark.file_ext}
            {benchmark.created_at && ` · ${new Date(benchmark.created_at).toLocaleDateString()}`}
          </span>
        </div>
      </div>

      {paretoSorted.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top 5 Compressors (Pareto Score)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Rank</th>
                    <th className="text-left py-2">Compressor</th>
                    <th className="text-right py-2">Ratio (%)</th>
                    <th className="text-right py-2">Throughput (MB/s)</th>
                    <th className="text-center py-2">Pareto</th>
                  </tr>
                </thead>
                <tbody>
                  {paretoSorted.map(([comp, count], i) => {
                    const r = results.find((r) => r.compressor === comp)
                    return (
                      <tr key={comp} className="border-b last:border-0">
                        <td className="py-2 text-muted-foreground">{i + 1}</td>
                        <td className="py-2 font-mono">{renameCompressor(comp)}</td>
                        <td className="text-right py-2">
                          {r?.compression_ratio != null ? (r.compression_ratio * 100).toFixed(2) : '-'}
                        </td>
                        <td className="text-right py-2">
                          {r?.compression_throughput_mbs != null ? r.compression_throughput_mbs.toFixed(2) : '-'}
                        </td>
                        <td className="text-center py-2">
                          <ParetoBadge dominationCount={count} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compression Ratio Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <OverviewBarChart results={results} />
          <RankedTable results={results} metric="compression_ratio" />
        </CardContent>
      </Card>

      {metricSections.filter((m) => m.show && m.key !== 'compression_ratio').map((section) => (
        <Card key={section.key}>
          <button
            className="w-full text-left"
            onClick={() => setExpandedMetric(expandedMetric === section.key ? null : section.key)}
          >
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                {section.label}
                <span className="text-muted-foreground">{expandedMetric === section.key ? '▼' : '▶'}</span>
              </CardTitle>
            </CardHeader>
          </button>
          {expandedMetric === section.key && (
            <CardContent className="space-y-4">
              {section.chart === 'bar' ? (
                <MetricBarChart results={results} metric={section.key} />
              ) : (
                <ScatterChartMetric results={results} metric={section.key} />
              )}
              <RankedTable results={results} metric={section.key} />
            </CardContent>
          )}
        </Card>
      ))}

    </div>
  )
}
const CustomScatterTooltip = ({ active, payload, metric }: any) => {
  if (active && payload && payload.length) {
    // Recharts stores the original data row inside payload[0].payload
    const dataPoint = payload[0].payload; 
    
    return (
      <div className="bg-background border border-border p-3 rounded-lg shadow-md text-sm">
        {/* Point Name */}
        <p className="font-bold text-foreground mb-1">{dataPoint.name}</p>
        <hr className="border-border my-1" />
        {/* X Data */}
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Compression Ratio:</span> {dataPoint.x.toFixed(2)}%
        </p>
        {/* Y Data */}
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{metricLabel(metric)}:</span> {formatMetricValue(dataPoint.y, metric)}
        </p>
      </div>
    );
  }

  return null;
};
