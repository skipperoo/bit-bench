import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { renameCompressor, getCompressorColor } from '@/lib/compressors'
import { formatMetricValue } from '@/lib/format'
import { buildLatexTable, copyToClipboard } from '@/lib/latex'
import type { LatexTableRow } from '@/lib/latex'
import type { Benchmark, CompareResponse, BenchmarkResult } from '@/types'

const EXCLUDED_METRICS = new Set([
  'num_values', 'original_size', 'dataset_size', 'dataset_base',
  'dataset_type', 'source_results_csv', 'input_buffer',
])

interface MetricDef {
  key: string
  label: string
}

function useCompareData(searchParams: URLSearchParams) {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([])
  const [results, setResults] = useState<Map<string, BenchmarkResult[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const ids = searchParams.get('ids')
    if (!ids) {
      setError('No benchmarks selected for comparison.')
      setLoading(false)
      return
    }
    apiFetch<CompareResponse>(`/benchmarks/compare?ids=${ids}`)
      .then((data) => {
        setBenchmarks(data.benchmarks || [])
        const map = new Map<string, BenchmarkResult[]>()
        for (const [id, res] of Object.entries(data.results || {})) {
          map.set(id, res)
        }
        setResults(map)
      })
      .catch(() => setError('Failed to load comparison data.'))
      .finally(() => setLoading(false))
  }, [searchParams])

  return { benchmarks, results, loading, error }
}

function getMetricDefs(results: BenchmarkResult[]): MetricDef[] {
  const keys = new Set<string>()
  for (const r of results) {
    for (const [k, v] of Object.entries(r as any)) {
      if (typeof v === 'number' && !EXCLUDED_METRICS.has(k)) keys.add(k)
    }
  }
  const order = [
    'compression_ratio', 'compression_throughput_mbs', 'decompression_throughput_mbs',
    'memory_usage', 'compressor_internal', 'random_access_ns', 'random_access_mbs',
  ]
  return [...keys]
    .sort((a, b) => {
      const ai = order.indexOf(a)
      const bi = order.indexOf(b)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
    .map((key) => ({ key, label: key.replace(/_/g, ' ').replace(/\\b(.)/g, (c) => c.toUpperCase()) }))
}

function ComparisonBarChart({ benchmarks, results }: { benchmarks: Benchmark[]; results: Map<string, BenchmarkResult[]> }) {
  const compressors = new Set<string>()
  const allResults = [...results.values()].flat()
  for (const r of allResults) compressors.add(r.compressor)
  const compList = [...compressors]

  const data = benchmarks.map((b) => {
    const point: Record<string, any> = { name: b.name }
    const benchResults = results.get(b.id) || []
    for (const r of benchResults) {
      if (r.compression_ratio != null) {
        point[r.compressor] = +(r.compression_ratio * 100).toFixed(2)
      }
    }
    return point
  })

  if (data.length === 0) return null

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 60, right: 20, top: 20, bottom: 80 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
          <YAxis tickFormatter={(v: number) => v.toFixed(2)} />
          <Tooltip formatter={(v: any) => `${Number(v).toFixed(2)}%`} />
          <Legend verticalAlign="bottom" height={36} />
          {compList.map((c) => (
            <Bar key={c} dataKey={c} fill={getCompressorColor(c)} name={renameCompressor(c)} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function MetricComparisonTable({
  metric,
  benchmarks,
  results,
  lowerIsBetter,
}: {
  metric: string
  benchmarks: Benchmark[]
  results: Map<string, BenchmarkResult[]>
  lowerIsBetter: boolean
}) {
  const compressors = new Set<string>()
  for (const r of [...results.values()].flat()) compressors.add(r.compressor)
  const compList = [...compressors]

  const benchRows: LatexTableRow[] = benchmarks.map((b) => {
    const benchResults = results.get(b.id) || []
    return {
      label: b.name,
      values: compList.map((c) => {
        const r = benchResults.find((br) => br.compressor === c)
        if (!r) return null
        const val = (r as any)[metric]
        if (val == null) return null
        if (metric === 'compression_ratio') return +(val * 100).toFixed(2)
        return val
      }),
    }
  })

  // Average row
  const avgRow: LatexTableRow = {
    label: 'Average',
    values: compList.map((_, ci) => {
      const vals = benchRows.map((r) => r.values[ci]).filter((v): v is number => v != null)
      if (vals.length === 0) return null
      return vals.reduce((a, b) => a + b, 0) / vals.length
    }),
  }

  const allRows = [...benchRows, avgRow]
  const colNames = compList.map((c) => renameCompressor(c))
  const caption = `${metric.charAt(0).toUpperCase() + metric.slice(1).replace(/_/g, ' ')}`

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left p-2">Benchmark</th>
            {compList.map((c) => (
              <th key={c} className="text-right p-2 font-mono text-xs">{renameCompressor(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allRows.map((row, ri) => {
            const allVals = row.values.filter((v): v is number => v != null)
            const sorted = [...allVals].sort((a, b) => lowerIsBetter ? a - b : b - a)
            return (
              <tr key={ri} className={`border-b ${ri === allRows.length - 1 ? 'font-semibold border-t-2' : ''}`}>
                <td className="p-2 text-xs">{row.label}</td>
                {row.values.map((v, ci) => {
                  if (v == null) return <td key={ci} className="text-right p-2 text-muted-foreground">-</td>
                  const rank = sorted.indexOf(v)
                  let cls = ''
                  if (rank === 0) cls = 'font-bold'
                  else if (rank === 1) cls = 'underline'
                  else if (rank === 2) cls = 'italic'
                  return <td key={ci} className={`text-right p-2 ${cls}`}>{formatMetricValue(v, metric)}</td>
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="flex justify-end mt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const latex = buildLatexTable(allRows, colNames, caption, lowerIsBetter)
            await copyToClipboard(latex)
          }}
        >
          Copy LaTeX
        </Button>
      </div>
    </div>
  )
}

export default function ComparePage() {
  const [searchParams] = useSearchParams()
  const { benchmarks, results, loading, error } = useCompareData(searchParams)

  if (loading) return <p className="text-muted-foreground p-6">Loading comparison...</p>
  if (error) return <p className="text-destructive p-6">{error}</p>
  if (benchmarks.length === 0) return <p className="text-muted-foreground p-6">No data to compare.</p>

  const allResults = [...results.values()].flat()

  const LOWER_IS_BETTER = new Set([
    'compression_ratio', 'compressed_bits', 'uncompressed_bits',
    'original_size', 'memory_usage', 'compressor_internal',
    'random_access_ns', 'internal_memory_ratio', 'relative_memory_usage',
  ])

  const metrics = getMetricDefs(allResults)

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Compare Benchmarks</h1>
      <p className="text-sm text-muted-foreground">
        Comparing {benchmarks.length} benchmarks: {benchmarks.map((b) => b.name).join(', ')}
      </p>

      {/* Grouped compression ratio bar chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compression Ratio</CardTitle>
        </CardHeader>
        <CardContent>
          <ComparisonBarChart benchmarks={benchmarks} results={results} />
          <div className="flex justify-end mt-2">
            <Button variant="outline" size="sm">Copy LaTeX</Button>
          </div>
        </CardContent>
      </Card>

      {/* Per-metric tables */}
      {metrics.filter((m) => m.key !== 'compression_ratio').map((metric) => (
        <Card key={metric.key}>
          <CardHeader>
            <CardTitle className="text-base">{metric.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricComparisonTable
              metric={metric.key}
              benchmarks={benchmarks}
              results={results}
              lowerIsBetter={LOWER_IS_BETTER.has(metric.key)}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
