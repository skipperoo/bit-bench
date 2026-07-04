import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import type { Benchmark } from '@/types'

const statusColors: Record<string, string> = {
  queued: 'bg-blue-100 text-blue-800 border-blue-200',
  in_progress: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  ready: 'bg-green-100 text-green-800 border-green-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
  timed_out: 'bg-orange-100 text-orange-800 border-orange-200',
  cancelled: 'bg-gray-100 text-gray-800 border-gray-200',
}

export default function ResultsPage() {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<Benchmark[]>(`/benchmarks?q=${search}`)
      .then(setBenchmarks)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [search])

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {benchmarks.map((b) => (
            <Link key={b.id} to={`/results/${b.id}`}>
              <Card className="h-full hover:shadow-md transition-shadow">
                <CardHeader>
                  <CardTitle className="text-base">{b.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Badge className={statusColors[b.status] || ''}>
                    {b.status}
                  </Badge>
                  <p className="text-xs text-muted-foreground">
                    {(b.file_size / 1024).toFixed(1)} KB &middot; {b.file_ext}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(b.created_at).toLocaleString()}
                  </p>
                  {Object.keys(b.compressors).length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-2">
                      {Object.keys(b.compressors).slice(0, 5).map((c) => (
                        <Badge key={c} variant="outline" className="text-xs">
                          {c}
                        </Badge>
                      ))}
                      {Object.keys(b.compressors).length > 5 && (
                        <Badge variant="outline" className="text-xs">
                          +{Object.keys(b.compressors).length - 5} other
                        </Badge>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
