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
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = async (cursor?: string) => {
    setLoading(true)
    try {
      const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const data = await apiFetch<{ benchmarks: Benchmark[]; next_cursor?: string }>(`/benchmarks${params}`)
      if (cursor) {
        setBenchmarks((prev) => [...prev, ...(data.benchmarks ?? [])])
      } else {
        setBenchmarks(data.benchmarks ?? [])
      }
      setNextCursor(data.next_cursor)
    } catch {}
    setLoading(false)
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
      setBenchmarks((prev) => prev.filter((b) => b.id !== id))
    } catch {}
  }

  const handleBatchDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} benchmark(s)?`)) return
    try {
      await apiFetch('/benchmarks/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: Array.from(selected) }),
      })
      setBenchmarks((prev) => prev.filter((b) => !selected.has(b.id)))
      setSelected(new Set())
    } catch {}
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === benchmarks.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(benchmarks.map((b) => b.id)))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Benchmarks</h1>
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={handleBatchDelete}>
            Delete {selected.size} selected
          </Button>
        )}
      </div>

      {loading && benchmarks.length === 0 ? (
        <p className="text-neutral-500">Loading...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm bg-white rounded-lg border">
            <thead>
              <tr className="border-b bg-neutral-50">
                <th className="p-3 w-10">
                  <input type="checkbox" onChange={toggleAll} checked={selected.size === benchmarks.length && benchmarks.length > 0} />
                </th>
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
                  <td className="p-3">
                    <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggleSelect(b.id)} />
                  </td>
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
          {nextCursor && (
            <Button variant="outline" className="mt-4 w-full" onClick={() => load(nextCursor)}>
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
