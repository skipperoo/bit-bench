import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import type { Benchmark, BenchmarkResult } from '@/types'

export default function DetailPage() {
  const { id } = useParams<{ id: string }>()
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    apiFetch<{ benchmark: Benchmark; results: BenchmarkResult[] }>(`/benchmarks/${id}`)
      .then((data) => {
        setBenchmark(data.benchmark)
        setResults(data.results)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <p className="text-muted-foreground">Loading...</p>
  if (!benchmark) return <p className="text-destructive">Benchmark not found</p>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{benchmark.name}</h1>
        <div className="flex items-center gap-2 mt-1">
          <Badge>{benchmark.status}</Badge>
          <span className="text-sm text-muted-foreground">
            {(benchmark.file_size / 1024).toFixed(1)} KB &middot; {benchmark.file_ext}
          </span>
        </div>
      </div>

      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Compression Ratio</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Compressor</th>
                    <th className="text-right py-2">Ratio (%)</th>
                    <th className="text-right py-2">Throughput (MB/s)</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.compressor} className="border-b last:border-0">
                      <td className="py-2 font-mono">{r.compressor}</td>
                      <td className="text-right py-2">
                        {r.compression_ratio != null
                          ? (r.compression_ratio * 100).toFixed(2)
                          : '-'}
                      </td>
                      <td className="text-right py-2">
                        {r.compression_throughput_mbs != null
                          ? r.compression_throughput_mbs.toFixed(2)
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
