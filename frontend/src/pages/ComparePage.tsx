import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ScatterChart, Scatter, ResponsiveContainer,
} from 'recharts'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import type { Benchmark, BenchmarkResult, CompareResponse, BenchmarkListResponse } from '@/types'

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#8b5cf6']

export default function ComparePage() {
  const [search, setSearch] = useState('')
  const [allBenchmarks, setAllBenchmarks] = useState<Benchmark[]>([])
  const [selected, setSelected] = useState<Benchmark[]>([])
  const [compareData, setCompareData] = useState<CompareResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('q', search)
    params.set('limit', '50')
    apiFetch<BenchmarkListResponse>(`/benchmarks?${params}`)
      .then((data) => setAllBenchmarks(data.benchmarks.filter((b) => b.status === 'ready')))
      .catch(() => {})
  }, [search])

  const handleCompare = async () => {
    if (selected.length < 2) return
    setLoading(true)
    try {
      const ids = selected.map((b) => b.id).join(',')
      const data = await apiFetch<CompareResponse>(`/benchmarks/compare?ids=${ids}`)
      setCompareData(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  function toggleBenchmark(b: Benchmark) {
    setSelected((prev) => {
      const exists = prev.find((sb) => sb.id === b.id)
      if (exists) return prev.filter((sb) => sb.id !== b.id)
      if (prev.length >= 5) return prev
      return [...prev, b]
    })
    setCompareData(null)
  }

  const allResults = compareData
    ? Object.entries(compareData.results).flatMap(([benchId, results]) =>
        results.map((r) => {
          const b = compareData.benchmarks.find((b) => b.id === benchId)
          return { ...r, benchmarkName: b?.name || benchId }
        })
      )
    : []

  function ComparisonBarChart({ metric }: { metric: string }) {
    const data = compareData?.benchmarks.map((b) => {
      const results = (compareData?.results[b.id] || []).filter((r) => (r as any)[metric] != null)
      if (results.length === 0) return null
      const point: Record<string, any> = { name: b.name }
      results.forEach((r) => {
        const val = (r as any)[metric]
        point[r.compressor] = metric === 'compression_ratio' ? +(val * 100).toFixed(2) : +val.toFixed(2)
      })
      return point
    }).filter(Boolean) as Record<string, any>[]

    if (!data || data.length === 0) return null

    const compressors = [...new Set(allResults.map((r) => r.compressor))]
    if (compressors.length === 0) return null

    return (
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
            <YAxis />
            <Tooltip />
            <Legend />
            {compressors.map((c, i) => (
              <Bar key={c} dataKey={c} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  function ComparisonScatterChart({ metric }: { metric: string }) {
    const data = allResults
      .filter((r) => (r as any)[metric] != null && r.compression_ratio != null)

    if (data.length === 0) return null

    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="compression_ratio"
              name="Ratio (%)"
              tickFormatter={(v: number) => (v * 100).toFixed(0)}
              label={{ value: 'Compression Ratio (%)', position: 'bottom' }}
            />
            <YAxis dataKey={metric} label={{ value: metric, angle: -90, position: 'insideLeft' }} />
            <Tooltip
              formatter={(v: number, name: string) => [v.toFixed(2), name === metric ? metric : 'Ratio']}
            />
            <Legend />
            {data.map((r, i) => (
              <Scatter
                key={`${r.benchmarkName}-${r.compressor}`}
                data={[{
                  compression_ratio: +(r.compression_ratio! * 100).toFixed(2),
                  [metric]: +((r as any)[metric]).toFixed(2),
                }]}
                fill={COLORS[i % COLORS.length]}
                name={`${r.benchmarkName} / ${r.compressor}`}
                legendType="circle"
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Compare Benchmarks</h1>
      <p className="text-muted-foreground">Select 2–5 completed benchmarks to compare.</p>

      <Input
        placeholder="Search benchmarks..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-md"
      />

      <div className="flex flex-wrap gap-2">
        {allBenchmarks.map((b) => {
          const isSelected = selected.some((sb) => sb.id === b.id)
          const isDisabled = selected.length >= 5 && !isSelected
          return (
            <Badge
              key={b.id}
              variant={isSelected ? 'default' : 'outline'}
              className={`cursor-pointer transition-colors ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={() => !isDisabled && toggleBenchmark(b)}
            >
              {b.name}
            </Badge>
          )
        })}
      </div>

      {selected.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Selected ({selected.length}/5):</span>
          {selected.map((b) => (
            <Badge key={b.id} variant="secondary" className="cursor-pointer" onClick={() => toggleBenchmark(b)}>
              {b.name} ×
            </Badge>
          ))}
        </div>
      )}

      <Button
        onClick={handleCompare}
        disabled={selected.length < 2 || loading}
      >
        {loading ? 'Comparing...' : 'Compare'}
      </Button>

      {compareData && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compression Ratio Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <ComparisonBarChart metric="compression_ratio" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compression Throughput Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <ComparisonScatterChart metric="compression_throughput_mbs" />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
