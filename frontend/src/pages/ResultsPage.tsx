import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import type { Benchmark, BenchmarkListResponse, Config } from '@/types'
import { renameCompressor } from '@/lib/compressors'

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
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [maxCompare, setMaxCompare] = useState(5)
  const navigate = useNavigate()

  // Load config for maxCompare
  useEffect(() => {
    apiFetch<Config>('/config').then((c) => setMaxCompare(c.maxCompare)).catch(() => {})
  }, [])

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

  // Poll progress for active (queued or in_progress) benchmarks every 2s
  useEffect(() => {
    const active = benchmarks.filter(
      (b) => b.status === 'in_progress' || b.status === 'queued'
    )
    if (active.length === 0) return

    const interval = setInterval(async () => {
      for (const b of active) {
        try {
          const data = await apiFetch<{ progress: number; status: string }>(`/benchmarks/${b.id}/progress`)
          if (data.progress != null || data.status != null) {
            setBenchmarks((prev) =>
              prev.map((bm) => {
                if (bm.id !== b.id) return bm
                return {
                  ...bm,
                  progress: data.progress ?? bm.progress,
                  status: data.status && data.status !== bm.status
                    ? data.status as Benchmark['status']
                    : bm.status,
                }
              })
            )
          }
        } catch { /* ignore */ }
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [benchmarks])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Results</h1>
      <Input
        placeholder="Search benchmarks..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-md"
      />
      <div className="flex items-center gap-3">
        {selectMode ? (
          <>
            <Button variant="default" size="sm" onClick={() => {
              if (selectedIds.size >= 2) {
                navigate(`/compare?ids=${[...selectedIds].join(',')}`)
              }
            }} disabled={selectedIds.size < 2}>
              Compare ({selectedIds.size})
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }}>
              Cancel
            </Button>
            {selectedIds.size < 2 && (
              <span className="text-xs text-muted-foreground">Select at least 2 benchmarks</span>
            )}
            <span className="text-xs text-muted-foreground">Max {maxCompare}</span>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setSelectMode(true)}>
            Compare
          </Button>
        )}
      </div>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : benchmarks.length === 0 ? (
        <p className="text-muted-foreground">No benchmarks found.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {benchmarks.map((b) => {
              const isSelected = selectedIds.has(b.id)
              return (
                <Card className={`h-full transition-shadow ${selectMode ? (isSelected ? 'ring-2 ring-primary cursor-pointer' : 'opacity-70 cursor-pointer') : 'hover:shadow-md cursor-pointer'}`}
                  onClick={() => {
                    if (!selectMode) {
                      navigate(`/results/${b.id}`)
                      return
                    }
                    setSelectedIds((prev) => {
                      const next = new Set(prev)
                      if (next.has(b.id)) next.delete(b.id)
                      else if (next.size < maxCompare) next.add(b.id)
                      return next
                    })
                  }}>
                  <CardHeader>
                    <CardTitle className="text-base truncate flex items-center gap-2">
                      {selectMode && (
                        <input type="checkbox" className="shrink-0" checked={isSelected} readOnly />
                      )}
                      {b.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge className={statusColors[b.status] || ''}>
                        {b.status === 'in_progress' && (
                          <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 animate-pulse mr-1" />
                        )}
                        {b.status === 'in_progress' && b.progress != null
                          ? `${b.status.split('_')
                                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                .join(' ')} (${b.progress}%)`
                          : b.status.split('_')
                                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                .join(' ')}
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
                            {renameCompressor(c)}
                          </Badge>
                        ))}
                        {Object.keys(b.compressors).length > 5 && (
                          <div className="relative group">
                            <Badge variant="outline" className="text-xs cursor-default">
                              +{Object.keys(b.compressors).length - 5}
                            </Badge>
                            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-10">
                              <div className="bg-popover border border-border text-popover-foreground rounded-lg shadow-lg p-2 text-xs overflow-y-auto" style={{ maxHeight: '200px', minWidth: '120px' }}>
                                {Object.keys(b.compressors).map((c) => (
                                  <div key={c} className="py-0.5">{renameCompressor(c)}</div>
                                ))}
                              </div>
                              <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-popover-foreground/20" />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
            )})}
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
