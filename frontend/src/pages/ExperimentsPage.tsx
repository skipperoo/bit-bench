import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2, LineChart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import StatusPill from '@/components/StatusPill'
import { apiFetch } from '@/lib/api'
import { renameCompressor } from '@/lib/compressors'
import { VIEW_LIMIT, benchmarkDurationMs, dataSourceText, experimentSourceText, formatDuration, groupExperiments, viewPath } from '@/lib/experiments'
import { isActive } from '@/lib/status'
import type { Benchmark, BenchmarkListResponse } from '@/types'
import type { DatasetListResponse } from '@/lib/datasets'

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'queued,in_progress', label: 'Active' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed,timed_out', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

function compressorSummary(b: Benchmark): string {
  const labels = b.compressors.map((c) => renameCompressor(c.label))
  return labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} +${labels.length - 3}`
}

export default function ExperimentsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [datasets, setDatasets] = useState<string[]>([])
  const [search, setSearch] = useState(params.get('q') ?? '')

  const filters = useMemo(() => ({
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    source: params.get('source') ?? '',
    dataset: params.get('dataset') ?? '',
    compressor: params.get('compressor') ?? '',
  }), [params])

  const setFilter = useCallback((key: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    }, { replace: true })
  }, [setParams])

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = setTimeout(() => { if (search.trim() !== filters.q) setFilter('q', search.trim()) }, 250)
    return () => clearTimeout(t)
  }, [search, filters.q, setFilter])

  useEffect(() => {
    apiFetch<Partial<DatasetListResponse>>('/datasets')
      .then((d) => setDatasets(Array.isArray(d?.datasets) ? d.datasets.map((x) => x.name) : []))
      .catch(() => {})
  }, [])

  const load = useCallback(async (cursor?: string) => {
    if (!cursor) setLoading(true)
    try {
      const q = new URLSearchParams({ limit: '50' })
      for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v)
      if (cursor) q.set('cursor', cursor)
      const data = await apiFetch<BenchmarkListResponse>(`/benchmarks?${q}`)
      const page = data?.benchmarks ?? []
      setBenchmarks((prev) => (cursor ? [...prev, ...page] : page))
      setNextCursor(data?.next_cursor)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load experiments')
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { setSelected(new Set()); load() }, [load])

  // Poll active benchmarks; keyed on the set of active ids.
  const activeIds = benchmarks.filter((b) => isActive(b.status)).map((b) => b.id).join(',')
  useEffect(() => {
    if (!activeIds) return
    const ids = activeIds.split(',')
    const timer = setInterval(async () => {
      for (const id of ids) {
        try {
          const s = await apiFetch<Pick<Benchmark, 'status' | 'progress' | 'started_at' | 'finished_at' | 'error'>>(`/benchmarks/${id}/progress`)
          setBenchmarks((prev) => prev.map((b) => (b.id === id ? { ...b, ...s } : b)))
        } catch { /* ignore */ }
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [activeIds])

  const experiments = useMemo(() => groupExperiments(benchmarks), [benchmarks])
  const selectedBenchmarks = benchmarks.filter((b) => selected.has(b.id))

  const toggle = (ids: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    return next
  })

  const deleteSelected = async () => {
    if (!confirm(`Delete ${selected.size} benchmark(s) and their results? This cannot be undone.`)) return
    const failed: string[] = []
    for (const id of selected) {
      try {
        await apiFetch(`/benchmarks/${id}`, { method: 'DELETE' })
      } catch (err) {
        failed.push(err instanceof Error ? err.message : id)
      }
    }
    if (failed.length) alert(`Some deletions failed:\n${failed.join('\n')}`)
    setSelected(new Set())
    load()
  }

  const rerun = () => {
    const b = selectedBenchmarks[0]
    if (!b) return
    navigate('/new', {
      state: {
        rerun: {
          name: b.name,
          compressors: b.compressors.map((c) => ({ name: c.name, options: c.options })),
          aggregation: b.aggregation,
          measureMemory: b.measure_memory,
          source: b.source,
        },
      },
    })
  }

  const anyFilter = Object.values(filters).some(Boolean)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>
        <Button asChild size="sm"><Link to="/new"><Plus className="w-4 h-4 mr-1" />New experiment</Link></Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <Input aria-label="Search by name" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} className="lg:col-span-2" />
        <select aria-label="Status" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          aria-label="Data source"
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          value={filters.dataset ? `dataset:${filters.dataset}` : filters.source}
          onChange={(e) => {
            const v = e.target.value
            setParams((prev) => {
              const next = new URLSearchParams(prev)
              next.delete('source'); next.delete('dataset')
              if (v.startsWith('dataset:')) next.set('dataset', v.slice(8))
              else if (v) next.set('source', v)
              return next
            }, { replace: true })
          }}
        >
          <option value="">Any data</option>
          <option value="upload">Uploaded files</option>
          <option value="dataset">Any dataset</option>
          {datasets.map((d) => <option key={d} value={`dataset:${d}`}>Dataset: {d}</option>)}
        </select>
        <Input aria-label="Compressor" placeholder="Compressor (e.g. gzip)" value={filters.compressor} onChange={(e) => setFilter('compressor', e.target.value.trim())} />
      </div>

      {selected.size > 0 && (
        <div role="toolbar" aria-label="Selection" className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={selected.size > VIEW_LIMIT} onClick={() => navigate(viewPath([...selected]))}>
            <LineChart className="w-4 h-4 mr-1" />{selected.size === 1 ? 'Open' : 'Compare'}
          </Button>
          <Button size="sm" variant="outline" disabled={selectedBenchmarks.length !== 1} onClick={rerun} title="Start a new experiment with the same configuration">
            <RotateCcw className="w-4 h-4 mr-1" />Re-run
          </Button>
          <Button size="sm" variant="outline" onClick={deleteSelected}><Trash2 className="w-4 h-4 mr-1" />Delete</Button>
          <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>Clear</button>
          {selected.size > VIEW_LIMIT && <span className="text-xs text-destructive">At most {VIEW_LIMIT} benchmarks per view</span>}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : experiments.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {anyFilter ? 'No experiments match these filters.' : <>No experiments yet. <Link className="underline" to="/new">Start one</Link>.</>}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="w-8 p-2"><span className="sr-only">Select</span></th>
                <th className="p-2 font-medium min-w-[12rem]">Name</th>
                <th className="p-2 font-medium">Data</th>
                <th className="p-2 font-medium">Compressors</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 font-medium">Created</th>
                <th className="p-2 font-medium text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((exp) => {
                const ids = exp.benchmarks.map((b) => b.id)
                const group = exp.benchmarks.length > 1
                const open = expanded.has(exp.id)
                const allSelected = ids.every((id) => selected.has(id))
                const first = exp.benchmarks[0]
                return (
                  <Fragment key={exp.id}>
                    <tr className="border-b border-border last:border-0 hover:bg-secondary/30">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${exp.name}`}
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = !allSelected && ids.some((id) => selected.has(id)) }}
                          onChange={(e) => toggle(ids, e.target.checked)}
                        />
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          {group && (
                            <button
                              type="button"
                              aria-label={open ? `Collapse ${exp.name}` : `Expand ${exp.name}`}
                              aria-expanded={open}
                              className="p-0.5 rounded hover:bg-secondary"
                              onClick={() => setExpanded((prev) => { const n = new Set(prev); if (n.has(exp.id)) n.delete(exp.id); else n.add(exp.id); return n })}
                            >
                              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </button>
                          )}
                          <Link to={viewPath(ids.slice(0, VIEW_LIMIT))} className="font-medium hover:underline">{exp.name}</Link>
                          {group && <span className="text-xs text-muted-foreground">({exp.benchmarks.length})</span>}
                        </div>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{experimentSourceText(exp.benchmarks)}</td>
                      <td className="p-2 text-xs font-mono">{compressorSummary(first)}</td>
                      <td className="p-2"><StatusPill status={exp.status} progress={group ? undefined : first.progress} /></td>
                      <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(exp.createdAt).toLocaleString()}</td>
                      <td className="p-2 text-xs text-right tabular-nums">{formatDuration(exp.durationMs)}</td>
                    </tr>
                    {group && open && exp.benchmarks.map((b) => (
                      <tr key={b.id} className="border-b border-border bg-secondary/10 hover:bg-secondary/30">
                        <td className="p-2 pl-4">
                          <input type="checkbox" aria-label={`Select ${b.name}`} checked={selected.has(b.id)} onChange={(e) => toggle([b.id], e.target.checked)} />
                        </td>
                        <td className="p-2 pl-8"><Link to={viewPath([b.id])} className="hover:underline">{b.name}</Link></td>
                        <td className="p-2 text-xs text-muted-foreground">{dataSourceText(b)}</td>
                        <td className="p-2 text-xs font-mono">{compressorSummary(b)}</td>
                        <td className="p-2"><StatusPill status={b.status} progress={b.progress} /></td>
                        <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(b.created_at).toLocaleString()}</td>
                        <td className="p-2 text-xs text-right tabular-nums">{formatDuration(benchmarkDurationMs(b))}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => load(nextCursor)}>Load more</Button>
        </div>
      )}
    </div>
  )
}
