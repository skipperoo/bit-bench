import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import type { Benchmark, BenchmarkListResponse } from '@/types'

const statusColors: Record<string, string> = {
  queued: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  in_progress: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  ready: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200',
  timed_out: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200',
  cancelled: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-700 dark:text-gray-200',
}

export default function ResultsPage() {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([])
  const [search, setSearch] = useState('')
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadBenchmarks = useCallback(async (cursor?: string, append = false) => {
    if (!append) setLoading(true)
    else setLoadingMore(true)
    try {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      if (cursor) params.set('cursor', cursor)
      params.set('limit', '20')
      const data = await apiFetch<BenchmarkListResponse>(`/benchmarks?${params}`)
      const benchmarks = data.benchmarks ?? []
      if (append) {
        setBenchmarks((prev) => [...prev, ...benchmarks])
      } else {
        setBenchmarks(benchmarks)
      }
      setNextCursor(data.next_cursor)
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [search])

  useEffect(() => {
    loadBenchmarks()
  }, [loadBenchmarks])

  // Poll every 5s if any benchmark is in_progress or queued
  useEffect(() => {
    const hasActive = benchmarks.some((b) => b.status === 'in_progress' || b.status === 'queued')
    if (!hasActive) return
    const interval = setInterval(() => loadBenchmarks(), 5000)
    return () => clearInterval(interval)
  }, [benchmarks, loadBenchmarks])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Results</h1>
      <Input
        placeholder="Search benchmarks..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-md"
      />
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : benchmarks.length === 0 ? (
        <p className="text-muted-foreground">No benchmarks found.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {benchmarks.map((b) => (
              <Link key={b.id} to={`/results/${b.id}`}>
                <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                  <CardHeader>
                    <CardTitle className="text-base truncate">{b.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge className={statusColors[b.status] || ''}>
                        {b.status === 'in_progress' && (
                          <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 animate-pulse mr-1" />
                        )}
                        {b.status === 'in_progress' && b.progress != null
                          ? `${b.status} (${b.progress}%)`
                          : b.status}
                      </Badge>
                    </div>
                    {b.status === 'in_progress' && b.progress != null && (
                      <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-700">
                        <div
                          className="bg-yellow-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${b.progress}%` }}
                        />
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {(b.file_size / 1024).toFixed(1)} KB &middot; {b.file_ext}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(b.created_at).toLocaleString()}
                    </p>
                    {b.started_at && (
                      <p className="text-xs text-muted-foreground">
                        Started {new Date(b.started_at).toLocaleString()}
                      </p>
                    )}
                    {b.finished_at && (
                      <p className="text-xs text-muted-foreground">
                        Finished {new Date(b.finished_at).toLocaleString()}
                      </p>
                    )}
                    {Object.keys(b.compressors).length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-2">
                        {Object.keys(b.compressors).slice(0, 5).map((c) => (
                          <Badge key={c} variant="outline" className="text-xs">
                            {c}
                          </Badge>
                        ))}
                        {Object.keys(b.compressors).length > 5 && (
                          <Badge variant="outline" className="text-xs">
                            +{Object.keys(b.compressors).length - 5}
                          </Badge>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={() => loadBenchmarks(nextCursor, true)}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
