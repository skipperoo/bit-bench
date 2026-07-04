import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import type { Benchmark } from '@/types'

const statusColors: Record<string, string> = {
  queued: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  ready: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  timed_out: 'bg-orange-100 text-orange-800',
  cancelled: 'bg-gray-100 text-gray-800',
}

export default function BenchmarksPage() {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    apiFetch<Benchmark[]>('/benchmarks')
      .then((data) => setBenchmarks(data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleCancel = async (id: string) => {
    if (!confirm('Cancel this benchmark?')) return
    try {
      await apiFetch(`/benchmarks/${id}/cancel`, { method: 'POST' })
      load()
    } catch {}
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Permanently delete this benchmark and its results?')) return
    try {
      await apiFetch(`/benchmarks/${id}`, { method: 'DELETE' })
      load()
    } catch {}
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Benchmarks</h1>

      {loading ? (
        <p className="text-neutral-500">Loading...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm bg-white rounded-lg border">
            <thead>
              <tr className="border-b bg-neutral-50">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">File</th>
                <th className="text-left p-3">Created</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {benchmarks.map((b) => (
                <tr key={b.id} className="border-b last:border-0 hover:bg-neutral-50">
                  <td className="p-3 font-medium">{b.name}</td>
                  <td className="p-3">
                    <Badge className={statusColors[b.status] || ''}>{b.status}</Badge>
                  </td>
                  <td className="p-3 text-neutral-500">
                    {(b.file_size / 1024).toFixed(1)} KB
                  </td>
                  <td className="p-3 text-neutral-500 text-xs">
                    {new Date(b.created_at).toLocaleString()}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    {(b.status === 'queued' || b.status === 'in_progress') && (
                      <Button variant="outline" size="sm" onClick={() => handleCancel(b.id)}>
                        Cancel
                      </Button>
                    )}
                    <Button variant="destructive" size="sm" onClick={() => handleDelete(b.id)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
