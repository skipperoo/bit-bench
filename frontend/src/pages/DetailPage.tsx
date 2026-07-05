import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ScatterChart, Scatter, ResponsiveContainer, Cell,
} from 'recharts'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import type { Benchmark, BenchmarkResult, BenchmarkDetailResponse } from '@/types'

const COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  '#06b6d4', '#d946ef', '#64748b',
]

const LOWER_IS_BETTER = new Set([
  'compression_ratio', 'compressed_bits', 'uncompressed_bits',
  'original_size', 'memory_usage', 'compressor_internal', 'random_access_ns',
])

function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    compression_ratio: 'Compression Ratio (%)',
    compression_throughput_mbs: 'Compression Throughput (MB/s)',
    decompression_throughput_mbs: 'Decompression Throughput (MB/s)',
    memory_usage: 'Memory Usage (MB)',
    compressor_internal: 'Compressor Memory (MB)',
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
      name: r.compressor,
      ratio: +(r.compression_ratio! * 100).toFixed(2),
    }))

  if (data.length === 0) return <p className="text-sm text-muted-foreground">No data</p>

  return (
    <div className="h-[432px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 80, right: 20, top: 20, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
          <YAxis
            label={{ value: 'Ratio (%)', angle: -90, position: 'outside', offset: 45 }}
          />
          <Tooltip formatter={(v: any) => v != null ? `${Number(v).toFixed(2)}%` : '-'} />
          <Bar dataKey="ratio" fill="#2563eb" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function MetricBarChart({ results, metric }: { results: BenchmarkResult[]; metric: string }) {
  const data = results
    .filter((r) => (r as any)[metric] != null)
    .map((r) => ({
      name: r.compressor,
      [metric]: metric === 'compression_ratio'
        ? +((r as any)[metric] * 100).toFixed(2)
        : +((r as any)[metric]).toFixed(2),
    }))

  if (data.length === 0) return null
  const label = metric === 'compression_ratio' ? 'Ratio (%)' : metricLabel(metric)

  return (
    <div className="h-[384px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 80, right: 20, top: 20, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
          <YAxis
            label={{ value: label, angle: -90, position: 'outside', offset: 45 }}
          />
          <Tooltip />
          <Bar dataKey={metric} fill="#16a34a" />
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
      name: r.compressor,
    }))
    .sort((a, b) => a.x - b.x)

  if (data.length === 0) return null

  return (
    <div>
      <div className="h-[480px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ left: 80, right: 20, top: 20, bottom: 120 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="x"
              name="Compression Ratio (%)"
              label={{ value: 'Compression Ratio (%)', position: 'bottom', offset: 50 }}
            />
            <YAxis
              dataKey="y"
              name={metricLabel(metric)}
              label={{ value: metricLabel(metric), angle: -90, position: 'outside', offset: 45 }}
            />
            <Tooltip
              formatter={(v: any, name: any) => {
                const val = v != null ? Number(v).toFixed(2) : '-'
                if (name === 'y') return [val, metricLabel(metric)]
                return [`${val}%`, 'Compression Ratio']
              }}
            />
            <Scatter data={data} fill="#2563eb" name="Compressors">
              {data.map((d, i) => (
                <Cell key={d.name} fill={COLORS[i % COLORS.length]} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {/* Custom legend showing each compressor name with its color */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 justify-center -mt-4">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
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

  return (
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
                {r.compressor}
              </td>
              <td className="text-right py-1">{r.value.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
                        <td className="py-2 font-mono">{comp}</td>
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
