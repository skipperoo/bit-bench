import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash2, LineChart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import StatusPill from '@/components/StatusPill'
import SharedWithMe from '@/components/SharedWithMe'
import { Sheet } from '@/components/ui/sheet'
import { useIsPhone } from '@/lib/responsive'
import { apiFetch } from '@/lib/api'
import { renameCompressor } from '@/lib/compressors'
import { useChartStyles } from '@/stores/chart-styles-store'
import { VIEW_LIMIT, benchmarkDurationMs, rerunConfig, dataSourceText, experimentSourceText, formatDuration, groupExperiments, renameExperiment, viewPath } from '@/lib/experiments'
import { isActive } from '@/lib/status'
import type { Benchmark, BenchmarkListResponse } from '@/types'
import type { Experiment } from '@/lib/experiments'
import type { DatasetListResponse } from '@/lib/datasets'

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'queued,in_progress', label: 'Active' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed,timed_out', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

/** Experiments (table rows) per page; remembered per browser. */
const PAGE_SIZES = ['25', '50', '100', 'all'] as const
type PageSize = (typeof PAGE_SIZES)[number]
const PAGE_SIZE_KEY = 'bitbench-experiments-per-page'

function storedPageSize(): PageSize {
  try {
    const v = localStorage.getItem(PAGE_SIZE_KEY)
    return PAGE_SIZES.includes(v as PageSize) ? (v as PageSize) : '25'
  } catch {
    return '25'
  }
}

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
  const [renaming, setRenaming] = useState<string | null>(null)
  const phone = useIsPhone()
  // Phones: checkboxes only in select mode; filters other than search and status live in a sheet.
  const [selecting, setSelecting] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [phoneRename, setPhoneRename] = useState<Experiment | null>(null)
  const [datasets, setDatasets] = useState<string[]>([])
  const [search, setSearch] = useState(params.get('q') ?? '')
  const [pageSize, setPageSize] = useState<PageSize>(storedPageSize)
  const changePageSize = (v: PageSize) => {
    setPageSize(v)
    try { localStorage.setItem(PAGE_SIZE_KEY, v) } catch { /* not remembered */ }
  }
  useChartStyles((st) => st.names) // re-render with the user's compressor names
  useEffect(() => { useChartStyles.getState().load() }, [])

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
      // Paged by experiments, so an experiment's benchmarks are never split.
      const q = new URLSearchParams({ experiments: pageSize })
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
  }, [filters, pageSize])

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

  // Visible checkbox rows in table order, for shift-click range selection.
  const rows = useMemo(() => experiments.flatMap((exp) => {
    const head = { key: `e:${exp.id}`, ids: exp.benchmarks.map((b) => b.id) }
    return exp.benchmarks.length > 1 && expanded.has(exp.id)
      ? [head, ...exp.benchmarks.map((b) => ({ key: `b:${b.id}`, ids: [b.id] }))]
      : [head]
  }), [experiments, expanded])
  const anchor = useRef<string | null>(null)
  const rowCheckbox = (key: string, ids: string[]) => ({
    // Shift-click would otherwise also select the text between the rows.
    onMouseDown: (e: MouseEvent) => { if (e.shiftKey) e.preventDefault() },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const from = rows.findIndex((r) => r.key === anchor.current)
      const to = rows.findIndex((r) => r.key === key)
      const range = (e.nativeEvent as globalThis.MouseEvent).shiftKey && from >= 0 && to >= 0
        ? rows.slice(Math.min(from, to), Math.max(from, to) + 1).flatMap((r) => r.ids)
        : ids
      toggle(range, e.target.checked)
      anchor.current = key
    },
  })
  const allIds = benchmarks.map((b) => b.id)
  const everySelected = allIds.length > 0 && allIds.every((id) => selected.has(id))

  const rename = async (exp: Experiment, value: string) => {
    setRenaming(null)
    const name = value.trim()
    if (!name || name === exp.name) return
    try {
      const renamed = await Promise.all(renameExperiment(exp, name).map((r) =>
        apiFetch<{ id: string; name: string }>(`/benchmarks/${r.id}`, { method: 'PATCH', body: JSON.stringify({ name: r.name }) })))
      const byId = new Map(renamed.map((r) => [r.id, r.name]))
      setBenchmarks((prev) => prev.map((b) => (byId.has(b.id) ? { ...b, name: byId.get(b.id)! } : b)))
    } catch (err) {
      setError(`Rename failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      load()
    }
  }

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
    setSelecting(false)
    load()
  }

  // Re-run works on one experiment: a dataset run comes back with all of its
  // chunk sizes and transforms.
  const rerunState = rerunConfig(selectedBenchmarks)
  const rerun = () => {
    if (rerunState) navigate('/new', { state: { rerun: rerunState } })
  }

  const anyFilter = Object.values(filters).some(Boolean)
  const sheetFilters = [filters.source || filters.dataset, filters.compressor].filter(Boolean).length
  const fullySelected = experiments.filter((e) => e.benchmarks.every((b) => selected.has(b.id)))
  const renamable = fullySelected.length === 1 && fullySelected[0].benchmarks.length === selected.size ? fullySelected[0] : null

  const sourceSelect = (
    <select
      aria-label="Data source"
      className="h-9 rounded-md border border-input bg-transparent px-2 text-sm max-md:h-11 max-md:w-full"
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
  )
  const compressorInput = <Input aria-label="Compressor" placeholder="Compressor (e.g. gzip)" value={filters.compressor} onChange={(e) => setFilter('compressor', e.target.value.trim())} className="w-full sm:w-48 max-md:h-11" />
  const pageSizeSelect = (
    <select
      aria-label="Experiments per page"
      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground max-md:h-11 max-md:w-full"
      value={pageSize}
      onChange={(e) => changePageSize(e.target.value as PageSize)}
    >
      {PAGE_SIZES.map((v) => <option key={v} value={v}>{v === 'all' ? 'All' : v}</option>)}
    </select>
  )

  const toggleExpanded = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

  // Phone rows: the same facts as the table columns, on two lines.
  const phoneList = () => (
    <ul className="space-y-2">
      {experiments.map((exp) => {
        const ids = exp.benchmarks.map((b) => b.id)
        const group = exp.benchmarks.length > 1
        const open = expanded.has(exp.id)
        const allSelected = ids.every((id) => selected.has(id))
        const first = exp.benchmarks[0]
        const body = (
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{exp.name}</span>
              <StatusPill status={exp.status} progress={group ? undefined : first.progress} />
            </div>
            <p className="truncate text-xs text-muted-foreground">{experimentSourceText(exp.benchmarks)}{group && ` · ${exp.benchmarks.length} benchmarks`}</p>
            <p className="truncate text-xs text-muted-foreground">{compressorSummary(first)} · {exp.durationMs ? formatDuration(exp.durationMs) : when(exp.createdAt)}</p>
          </div>
        )
        return (
          <li key={exp.id} className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-stretch">
              {selecting ? (
                <label className="flex min-w-0 flex-1 items-start gap-3 p-3">
                  <input type="checkbox" className="mt-1 h-4 w-4" aria-label={`Select ${exp.name}`} checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = !allSelected && ids.some((id) => selected.has(id)) }}
                    onChange={(e) => toggle(ids, e.target.checked)} />
                  {body}
                </label>
              ) : (
                <Link to={viewPath(ids.slice(0, VIEW_LIMIT))} viewTransition className="flex min-w-0 flex-1 p-3 transition-colors active:bg-secondary/60">{body}</Link>
              )}
              {group && (
                <button type="button" aria-label={open ? `Collapse ${exp.name}` : `Expand ${exp.name}`} aria-expanded={open}
                  className="border-l border-border px-3 text-muted-foreground active:bg-secondary/60" onClick={() => toggleExpanded(exp.id)}>
                  <ChevronDown className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
                </button>
              )}
            </div>
            {group && open && (
              <ul className="divide-y divide-border border-t border-border bg-secondary/20 text-sm">
                {exp.benchmarks.map((b) => (
                  <li key={b.id}>
                    {selecting ? (
                      <label className="flex items-center gap-3 px-3 py-2.5 pl-6">
                        <input type="checkbox" className="h-4 w-4" aria-label={`Select ${b.name}`} checked={selected.has(b.id)} onChange={(e) => toggle([b.id], e.target.checked)} />
                        <span className="min-w-0 flex-1 truncate">{b.name}</span>
                        <StatusPill status={b.status} progress={b.progress} />
                      </label>
                    ) : (
                      <Link to={viewPath([b.id])} viewTransition className="flex items-center gap-3 px-3 py-2.5 pl-6 active:bg-secondary/60">
                        <span className="min-w-0 flex-1 truncate">{b.name}</span>
                        <StatusPill status={b.status} progress={b.progress} />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>
        {phone ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => { setSelecting(!selecting); setSelected(new Set()) }}>{selecting ? 'Cancel' : 'Select'}</Button>
            <Button variant="ghost" size="sm" aria-label={`Filters${sheetFilters ? ` (${sheetFilters} set)` : ''}`} onClick={() => setFiltersOpen(true)} className="relative">
              <SlidersHorizontal className="h-5 w-5" />
              {sheetFilters > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />}
            </Button>
          </div>
        ) : (
          <Button asChild size="sm"><Link to="/new"><Plus className="w-4 h-4 mr-1" />New experiment</Link></Button>
        )}
      </div>

      <SharedWithMe />

      {phone ? (
        <div className="space-y-2" role="search">
          <Input aria-label="Search by name" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-11" />
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Status">
            {STATUS_FILTERS.map((st) => (
              <button key={st.value} type="button" aria-pressed={filters.status === st.value} onClick={() => setFilter('status', st.value)}
                className={`shrink-0 rounded-full border px-3 py-1 text-sm transition-colors ${filters.status === st.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                {st.value ? st.label : 'All'}
              </button>
            ))}
          </div>
          <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters"
            footer={<Button className="w-full" onClick={() => setFiltersOpen(false)}>Show experiments</Button>}>
            <div className="space-y-4">
              <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Data source</span>{sourceSelect}</label>
              <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Compressor</span>{compressorInput}</label>
              <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Experiments per page</span>{pageSizeSelect}</label>
              {anyFilter && <button type="button" className="text-sm underline underline-offset-2" onClick={() => { setSearch(''); setParams(new URLSearchParams(), { replace: true }) }}>Clear all filters</button>}
            </div>
          </Sheet>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-2" role="search">
        <Input aria-label="Search by name" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-64" />
        <select aria-label="Status" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {sourceSelect}
        {compressorInput}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Show
          {pageSizeSelect}
        </label>
      </div>
      )}

      {!phone && selected.size > 0 && (
        <div role="toolbar" aria-label="Selection" className="sticky top-14 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" disabled={selected.size > VIEW_LIMIT} onClick={() => navigate(viewPath([...selected]))}>
            <LineChart className="w-4 h-4 mr-1" />{selected.size === 1 ? 'Open' : 'Compare'}
          </Button>
          <Button size="sm" variant="outline" disabled={!rerunState} onClick={rerun} title={rerunState ? 'Start a new experiment with the same configuration' : 'Select the benchmarks of a single experiment to re-run it'}>
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
      ) : phone ? (
        phoneList()
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="w-8 p-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    title="Select all (shift-click a row to select a range)"
                    checked={everySelected}
                    ref={(el) => { if (el) el.indeterminate = !everySelected && selected.size > 0 }}
                    onChange={(e) => setSelected(e.target.checked ? new Set(allIds) : new Set())}
                  />
                </th>
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
                    <tr className="group border-b border-border last:border-0 hover:bg-secondary/30">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${exp.name}`}
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = !allSelected && ids.some((id) => selected.has(id)) }}
                          {...rowCheckbox(`e:${exp.id}`, ids)}
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
                          {renaming === exp.id ? (
                            <Input
                              autoFocus
                              aria-label={`New name for ${exp.name}`}
                              defaultValue={exp.name}
                              maxLength={200}
                              className="h-7 max-w-xs text-sm"
                              onFocus={(e) => e.target.select()}
                              onBlur={(e) => rename(exp, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                                // Restore first: a blur on unmount then saves nothing.
                                if (e.key === 'Escape') { e.currentTarget.value = exp.name; setRenaming(null) }
                              }}
                            />
                          ) : (
                            <>
                              <Link to={viewPath(ids.slice(0, VIEW_LIMIT))} className="font-medium hover:underline">{exp.name}</Link>
                              {group && <span className="text-xs text-muted-foreground">({exp.benchmarks.length})</span>}
                              <button
                                type="button"
                                aria-label={`Rename ${exp.name}`}
                                title="Rename"
                                className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                onClick={() => setRenaming(exp.id)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
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
                          <input type="checkbox" aria-label={`Select ${b.name}`} checked={selected.has(b.id)} {...rowCheckbox(`b:${b.id}`, [b.id])} />
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
      {phone && selecting && (
        <div role="toolbar" aria-label="Selection" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <p className="mb-1 text-center text-xs text-muted-foreground">
            {selected.size === 0 ? 'Tap experiments to select them' : `${selected.size} benchmark${selected.size === 1 ? '' : 's'} selected`}
            {selected.size > VIEW_LIMIT && ` · at most ${VIEW_LIMIT} per view`}
          </p>
          <div className="grid grid-cols-4">
            {[
              { label: selected.size === 1 ? 'Open' : 'Compare', icon: LineChart, disabled: selected.size === 0 || selected.size > VIEW_LIMIT, run: () => navigate(viewPath([...selected])) },
              { label: 'Re-run', icon: RotateCcw, disabled: !rerunState, run: rerun },
              { label: 'Rename', icon: Pencil, disabled: !renamable, run: () => setPhoneRename(renamable) },
              { label: 'Delete', icon: Trash2, disabled: selected.size === 0, run: deleteSelected, danger: true },
            ].map(({ label, icon: Icon, disabled, run, danger }) => (
              <button key={label} type="button" disabled={disabled} onClick={run}
                className={`flex flex-col items-center gap-0.5 rounded-md py-1.5 text-xs active:bg-secondary disabled:opacity-35 ${danger ? 'text-destructive' : ''}`}>
                <Icon className="h-5 w-5" />{label}
              </button>
            ))}
          </div>
        </div>
      )}
      <Sheet open={phoneRename !== null} onClose={() => setPhoneRename(null)} title="Rename experiment">
        {phoneRename && (
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault()
            const value = new FormData(e.currentTarget).get('name') as string
            rename(phoneRename, value)
            setPhoneRename(null)
          }}>
            <Input name="name" aria-label={`New name for ${phoneRename.name}`} defaultValue={phoneRename.name} maxLength={200} className="h-11" autoFocus />
            <p className="text-xs text-muted-foreground">Every benchmark keeps its own suffix.</p>
            <Button type="submit" className="w-full">Rename</Button>
          </form>
        )}
      </Sheet>
    </div>
  )
}
