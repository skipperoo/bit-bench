import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Download, X, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabPanel } from '@/components/ui/tabs'
import StatusPill from '@/components/StatusPill'
import EmulationNotice from '@/components/EmulationNotice'
import InstanceFilter from '@/components/InstanceFilter'
import SelfTestBadge from '@/components/SelfTestBadge'
import CompressorSwatch from '@/components/CompressorSwatch'
import RunMonitor from '@/components/RunMonitor'
import { GroupedBarChart, MetricBarChart, MetricScatterChart } from '@/components/charts/MetricCharts'
import SweepPanel from '@/components/SweepPanel'
import { ComparisonTable, RankedTable } from '@/components/ResultTables'
import { apiFetch } from '@/lib/api'
import { assignCompressorStyles, renameCompressor, shapeKey } from '@/lib/compressors'
import { useChartStyles } from '@/stores/chart-styles-store'
import { usePackageColors } from '@/lib/package-colors'
import { formatMetricValue, metricLabel } from '@/lib/format'
import { availableMetrics, metricValue, withDerivedMetrics } from '@/lib/metrics'
import type { MetricDef, MetricGroup } from '@/lib/metrics'
import { METRIC_GROUP_LABELS } from '@/lib/metrics'
import { paretoRanking } from '@/lib/pareto'
import { detectSweep, orderByChunkSize } from '@/lib/sweep'
import { allResultsCSV, downloadText } from '@/lib/csv'
import { VIEW_LIMIT, dataSourceText, experimentName, signalEntry, viewPath, withSignals } from '@/lib/experiments'
import { isActive } from '@/lib/status'
import type { Benchmark, BenchmarkDetailResponse, BenchmarkListResponse, BenchmarkResult, SeriesResults } from '@/types'

const GROUP_LABELS = METRIC_GROUP_LABELS

interface Loaded {
  benchmark: Benchmark
  results: BenchmarkResult[]
}

function useExperimentData(ids: string[]) {
  const [items, setItems] = useState<Loaded[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const key = ids.join(',')

  const load = useCallback(async (only?: string[]) => {
    const targets = only ?? key.split(',').filter(Boolean)
    const settled = await Promise.allSettled(targets.map((id) => apiFetch<BenchmarkDetailResponse>(`/benchmarks/${id}`)))
    const fresh = new Map<string, Loaded>()
    const lost: string[] = []
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value?.benchmark) {
        fresh.set(targets[i], { benchmark: s.value.benchmark, results: withDerivedMetrics(s.value.results ?? []) })
      } else {
        lost.push(targets[i])
      }
    })
    setItems((prev) => {
      const order = key.split(',').filter(Boolean)
      const byId = new Map(prev.map((p) => [p.benchmark.id, p]))
      for (const [id, item] of fresh) byId.set(id, item)
      return order.map((id) => byId.get(id)).filter((x): x is Loaded => Boolean(x))
    })
    if (!only) setMissing(lost)
    setLoading(false)
  }, [key])

  useEffect(() => { setLoading(true); setItems([]); load() }, [load])

  // Refresh running benchmarks until they finish.
  const active = items.filter((i) => isActive(i.benchmark.status)).map((i) => i.benchmark.id).join(',')
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => load(active.split(',')), 3000)
    return () => clearInterval(timer)
  }, [active, load])

  return { items, missing, loading, reload: load }
}

export default function ExperimentView() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, VIEW_LIMIT), [params])
  const { items, missing, loading, reload } = useExperimentData(ids)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [paretoTarget, setParetoTarget] = useState('')
  usePackageColors()

  const ready = orderByChunkSize(items.filter((i) => i.benchmark.status === 'ready' && i.results.length > 0), (i) => i.benchmark)
  // "Aggregate time series" off (URL signals=split): every signal of each
  // benchmark beside its aggregate. Per-signal results are loaded on demand.
  const aggregate = params.get('signals') !== 'split'
  const splittable = ready.some((i) => (i.benchmark.file_count ?? 1) > 1)
  const [seriesById, setSeriesById] = useState<Map<string, SeriesResults[]>>(new Map())
  const loadSeries = useCallback(async (benchmarkIds: string[]) => {
    const known = new Map(seriesById)
    const fetched = await Promise.all(benchmarkIds.filter((id) => !known.has(id)).map(async (id) =>
      [id, (await apiFetch<{ series: SeriesResults[] }>(`/benchmarks/${id}/series`))?.series ?? []] as const))
    if (fetched.length === 0) return known
    for (const [id, s] of fetched) known.set(id, s)
    setSeriesById(known)
    return known
  }, [seriesById])
  const readyKey = ready.map((i) => i.benchmark.id).join(',')
  useEffect(() => {
    if (!aggregate && readyKey) loadSeries(readyKey.split(',')).catch(() => { /* aggregate rows still show */ })
  }, [aggregate, readyKey, loadSeries])
  const shown = aggregate ? ready : ready.flatMap((i) => withSignals(i, seriesById.get(i.benchmark.id)).map(signalEntry))
  const setAggregate = (on: boolean) => setParams((prev) => {
    const n = new URLSearchParams(prev)
    if (on) n.delete('signals')
    else n.set('signals', 'split')
    return n
  }, { replace: true })
  const downloadAll = async () => {
    let series = seriesById
    try { series = await loadSeries(ready.map((i) => i.benchmark.id)) } catch { /* export the aggregates */ }
    const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'results'
    downloadText(`${name}-all.csv`, allResultsCSV(ready.flatMap((i) => withSignals(i, series.get(i.benchmark.id)))))
  }
  const multi = shown.length > 1
  const allNames = useMemo(() => [...new Set(ready.flatMap((i) => i.results.map((r) => r.compressor)))].sort(), [ready])
  const shapeOverrides = useChartStyles((st) => st.shapes)
  const colorOverrides = useChartStyles((st) => st.colors)
  const nameOverrides = useChartStyles((st) => st.names)
  const styleError = useChartStyles((st) => st.error)
  useEffect(() => { useChartStyles.getState().load() }, [])
  const styles = assignCompressorStyles(allNames, { shapes: shapeOverrides, colors: colorOverrides })
  const styleEditing = {
    defaults: assignCompressorStyles(allNames),
    overridden: (name: string) => ({ shape: shapeKey(name) in shapeOverrides, color: shapeKey(name) in colorOverrides, name: shapeKey(name) in nameOverrides }),
    onNameChange: (name: string, displayName: string | null) => { useChartStyles.getState().setName(name, displayName) },
    onShapeChange: (name: string, shape: string | null) => { useChartStyles.getState().setShape(name, shape) },
    onColorChange: (name: string, color: string | null) => { useChartStyles.getState().setColor(name, color) },
    onReset: (names: string[]) => { useChartStyles.getState().reset(names) },
    error: styleError,
  }
  const colors = new Map([...styles].map(([n, st]) => [n, st.color]))
  const shapes = new Map([...styles].map(([n, st]) => [n, st.shape]))
  const visibleNames = allNames.filter((n) => !hidden.has(n))
  const visible = shown.map((i) => ({ ...i, results: i.results.filter((r) => !hidden.has(r.compressor)) }))
  const allVisibleResults = visible.flatMap((i) => i.results)
  const metrics = availableMetrics(allVisibleResults)
  const groups = (Object.keys(GROUP_LABELS) as MetricGroup[]).filter((g) => metrics.some((m) => m.group === g))
  const sweep = useMemo(() => detectSweep(ready.map((i) => i.benchmark)), [ready])

  const tabItems = [
    { value: 'overview', label: 'Overview' },
    ...groups.map((g) => ({ value: g, label: GROUP_LABELS[g] })),
    ...(metrics.some((m) => m.key === 'compression_throughput_mbs') ? [{ value: 'pareto', label: 'Pareto' }] : []),
    ...(sweep ? [{ value: 'sweep', label: 'Sweep' }] : []),
  ]
  const requested = params.get('tab') ?? 'overview'
  const tab = tabItems.some((t) => t.value === requested) ? requested : 'overview'
  // Sweep metrics the user switched off, kept in the URL like the tab.
  const sweepHidden = useMemo(() => new Set((params.get('sweep_hide') ?? '').split(',').filter(Boolean)), [params])
  const setSweepHidden = (hidden: Set<string>) => setParams((prev) => {
    const n = new URLSearchParams(prev)
    if (hidden.size) n.set('sweep_hide', [...hidden].join(','))
    else n.delete('sweep_hide')
    return n
  }, { replace: true })
  const setTab = (value: string) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('tab', value); return n }, { replace: true })

  const removeId = (id: string) => navigate(viewPath(ids.filter((x) => x !== id)) + `&tab=${tab}`)

  if (ids.length === 0) return <p className="text-muted-foreground">No benchmark selected. <Link className="underline" to="/experiments">Back to experiments</Link></p>
  if (loading) return <p className="text-muted-foreground">Loading…</p>
  if (items.length === 0) return <p className="text-destructive">Benchmark not found.</p>

  const single = items.length === 1 ? items[0].benchmark : null
  const title = single ? single.name : experimentName(items.map((i) => i.benchmark.name))
  const instances = Array.from(new Map(items.flatMap((i) => i.benchmark.compressors).map((c) => [c.label, c])).values())
  const notReady = items.filter((i) => i.benchmark.status !== 'ready')

  const valueOf = (benchmarkId: string, compressor: string, metric: string) => {
    const item = visible.find((v) => v.benchmark.id === benchmarkId)
    const r = item?.results.find((x) => x.compressor === compressor)
    return r ? metricValue(r, metric) ?? null : null
  }

  const metricCard = (m: MetricDef) => {
    if (multi) {
      return (
        <Card key={m.key}>
          <CardHeader><CardTitle className="text-base">{metricLabel(m.key)}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <GroupedBarChart
              compressors={visibleNames}
              metric={m.key}
              series={visible.map((v) => ({
                id: v.benchmark.id,
                name: v.benchmark.name,
                values: new Map(v.results.map((r) => [r.compressor, metricValue(r, m.key)]).filter((e): e is [string, number] => e[1] != null)),
              }))}
            />
            <ComparisonTable
              benchmarks={visible.map((v) => ({ id: v.benchmark.id, name: v.benchmark.name }))}
              compressors={visibleNames}
              metric={m.key}
              colors={colors} shapes={shapes}
              value={(b, c) => valueOf(b, c, m.key)}
            />
          </CardContent>
        </Card>
      )
    }
    const results = visible[0]?.results ?? []
    const present = results.filter((r) => metricValue(r, m.key) != null)
    if (present.length === 0) return null
    const uncompressedRef = m.key === 'bits_per_element' ? results.find((r) => r.uncompressed_bits_per_element != null)?.uncompressed_bits_per_element : undefined
    return (
      <Card key={m.key}>
        <CardHeader><CardTitle className="text-base">{metricLabel(m.key)}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {m.chart === 'bar' ? (
            <MetricBarChart
              rows={present.map((r) => ({ compressor: r.compressor, value: metricValue(r, m.key)! }))}
              metric={m.key}
              colors={colors} shapes={shapes}
              reference={uncompressedRef != null ? { y: uncompressedRef, label: `input container ${uncompressedRef.toFixed(0)} b/e` } : undefined}
            />
          ) : (
            <MetricScatterChart
              rows={present.filter((r) => r.compression_ratio != null).map((r) => ({ compressor: r.compressor, ratio: r.compression_ratio!, value: metricValue(r, m.key)! }))}
              metric={m.key}
              colors={colors} shapes={shapes}
            />
          )}
          <RankedTable
            title={title}
            metric={m.key}
            colors={colors} shapes={shapes}
            referenceMetric={m.key === 'bits_per_element' ? 'uncompressed_bits_per_element' : undefined}
            rows={present.map((r) => ({
              compressor: r.compressor,
              value: metricValue(r, m.key)!,
              reference: r.uncompressed_bits_per_element,
              selfTestFailures: r.self_test_failures,
            }))}
          />
        </CardContent>
      </Card>
    )
  }

  const paretoItem = visible.find((v) => v.benchmark.id === paretoTarget) ?? visible[0]
  const topFive = paretoItem ? paretoRanking(paretoItem.results).slice(0, 5) : []

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {single && <StatusPill status={single.status} progress={single.progress} />}
        </div>
        {single ? (
          <p className="text-sm text-muted-foreground">
            {dataSourceText(single)}
            {` · ${new Date(single.created_at).toLocaleString()}`}
            {single.measure_memory === false && ' · memory not measured'}
            {single.source && <span className="block font-mono text-xs truncate" title={single.source.series.join(', ')}>series: {single.source.series.join(', ')}</span>}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label="Benchmarks in this view">
            {items.map((i) => (
              <li key={i.benchmark.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <Link to={viewPath([i.benchmark.id])} className="hover:underline">{i.benchmark.name}</Link>
                {i.benchmark.status !== 'ready' && <StatusPill status={i.benchmark.status} progress={i.benchmark.progress} />}
                <button type="button" aria-label={`Remove ${i.benchmark.name}`} className="text-muted-foreground hover:text-foreground" onClick={() => removeId(i.benchmark.id)}>
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <AddBenchmark ids={ids} onAdd={(id) => navigate(viewPath([...ids, id]) + `&tab=${tab}`)} />
      </div>

      {missing.length > 0 && <p className="text-sm text-destructive">{missing.length} benchmark(s) could not be loaded (deleted or not yours).</p>}

      {notReady.length > 0 && (
        <RunMonitor benchmarks={notReady.map((i) => i.benchmark)} onChange={() => reload()} />
      )}

      {items.some((i) => i.benchmark.warnings?.length) && (
        <div role="note" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Some measurements are missing or did not pass the self-test</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {items.flatMap((i) => (i.benchmark.warnings ?? []).map((w) => ({ w, name: i.benchmark.name }))).slice(0, 12).map(({ w, name }, k) => (
              <li key={k}>{multi || items.length > 1 ? <span className="font-medium">{name}: </span> : null}{w}</li>
            ))}
          </ul>
        </div>
      )}

      <EmulationNotice instances={instances} />

      {ready.length === 0 ? null : (
        <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-16 lg:self-start">
            <details className="lg:hidden rounded-md border border-border p-3">
              <summary className="flex items-center gap-2 text-sm cursor-pointer"><SlidersHorizontal className="w-4 h-4" />Filter compressors ({visibleNames.length}/{allNames.length})</summary>
              <div className="mt-3"><InstanceFilter names={allNames} colors={colors} shapes={shapes} hidden={hidden} onChange={setHidden} styleEditing={styleEditing} /></div>
            </details>
            <div className="hidden lg:block rounded-md border border-border p-3 max-h-[calc(100vh-6rem)] overflow-y-auto">
              <InstanceFilter names={allNames} colors={colors} shapes={shapes} hidden={hidden} onChange={setHidden} styleEditing={styleEditing} />
            </div>
          </aside>

          <div className="space-y-4 min-w-0">
            {splittable && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <label htmlFor="aggregate-signals" className="flex items-center gap-2">
                  <Switch id="aggregate-signals" checked={aggregate} onCheckedChange={setAggregate} />
                  Aggregate time series
                </label>
                <span className="text-xs text-muted-foreground">
                  {aggregate
                    ? 'Each benchmark shows one result over all its signals.'
                    : 'Each benchmark (chunk size and transform) shows its aggregate followed by every signal on its own.'}
                </span>
              </div>
            )}
            <Tabs items={tabItems} value={tab} onChange={setTab} ariaLabel="Result sections" idPrefix="exp" />
            {visibleNames.length === 0 ? (
              <p className="text-sm text-muted-foreground">Every compressor is hidden by the filter.</p>
            ) : (
              <TabPanel value={tab} idPrefix="exp" className="space-y-4">
                {tab === 'overview' && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>Every metric of every benchmark, signal and compressor in one file; each metric's table also has its own CSV.</span>
                      <Button variant="outline" size="sm" onClick={downloadAll}>
                        <Download className="mr-1 h-4 w-4" />Download all results (CSV)
                      </Button>
                    </div>
                    {!multi && topFive.length > 0 && <TopFive entries={topFive} results={paretoItem!.results} colors={colors} shapes={shapes} />}
                    {metrics.filter((m) => m.key === 'compression_ratio').map(metricCard)}
                  </>
                )}
                {groups.includes(tab as MetricGroup) && metrics.filter((m) => m.group === tab).map(metricCard)}
                {tab === 'pareto' && paretoItem && (
                  <>
                    {multi && (
                      <label className="flex items-center gap-2 text-sm">
                        Benchmark
                        <select className="h-8 rounded-md border border-input bg-transparent px-2 text-sm" value={paretoItem.benchmark.id} onChange={(e) => setParetoTarget(e.target.value)}>
                          {visible.map((v) => <option key={v.benchmark.id} value={v.benchmark.id}>{v.benchmark.name}</option>)}
                        </select>
                      </label>
                    )}
                    <TopFive entries={topFive} results={paretoItem.results} colors={colors} shapes={shapes} />
                    {(['compression_throughput_mbs', 'decompression_throughput_mbs'] as const).map((key) => {
                      const rows = paretoItem.results
                        .filter((r) => r.compression_ratio != null && metricValue(r, key) != null)
                        .map((r) => ({ compressor: r.compressor, ratio: r.compression_ratio!, value: metricValue(r, key)! }))
                      return rows.length ? (
                        <Card key={key}>
                          <CardHeader><CardTitle className="text-base">{metricLabel(key)} vs ratio — dashed: Pareto front</CardTitle></CardHeader>
                          <CardContent><MetricScatterChart rows={rows} metric={key} colors={colors} shapes={shapes} front /></CardContent>
                        </Card>
                      ) : null
                    })}
                  </>
                )}
                {tab === 'sweep' && sweep && (
                  <SweepPanel
                    sweep={sweep}
                    metrics={metrics}
                    compressors={visibleNames}
                    colors={colors}
                    shapes={shapes}
                    value={valueOf}
                    hidden={sweepHidden}
                    onHiddenChange={setSweepHidden}
                  />
                )}
              </TabPanel>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TopFive({ entries, results, colors, shapes }: {
  entries: { compressor: string; dominationCount: number }[]
  results: BenchmarkResult[]
  colors: Map<string, string>
  shapes?: Map<string, string>
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Top 5 (Pareto score: ratio vs compression throughput)</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 w-10">Rank</th>
              <th className="py-2">Compressor</th>
              <th className="py-2 text-right">Ratio</th>
              <th className="py-2 text-right">Throughput</th>
              <th className="py-2 text-right">Bits/element</th>
              <th className="py-2 text-center">Pareto</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const r = results.find((x) => x.compressor === e.compressor)
              return (
                <tr key={e.compressor} className="border-b border-border last:border-0">
                  <td className="py-1.5 text-muted-foreground">{i + 1}</td>
                  <td className="py-1.5 font-mono">
                    <span className="inline-flex items-center gap-1.5">
                      <CompressorSwatch name={e.compressor} color={colors.get(e.compressor)} shape={shapes?.get(e.compressor)} />
                      {renameCompressor(e.compressor)}
                      <SelfTestBadge failures={r?.self_test_failures} />
                    </span>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{r?.compression_ratio != null ? formatMetricValue(r.compression_ratio, 'compression_ratio') : '–'}</td>
                  <td className="py-1.5 text-right tabular-nums">{r?.compression_throughput_mbs != null ? `${r.compression_throughput_mbs.toFixed(2)} MB/s` : '–'}</td>
                  <td className="py-1.5 text-right tabular-nums" title={r?.uncompressed_bits_per_element != null ? `input container: ${r.uncompressed_bits_per_element.toFixed(0)} b/e` : undefined}>
                    {r?.bits_per_element != null ? r.bits_per_element.toFixed(2) : '–'}
                  </td>
                  <td className="py-1.5 text-center">
                    {e.dominationCount === 0 && <span className="rounded border border-green-200 bg-green-100 px-1.5 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200">Pareto-optimal</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

/** Picker that appends one of the user's recent ready benchmarks to the view. */
function AddBenchmark({ ids, onAdd }: { ids: string[]; onAdd: (id: string) => void }) {
  const [options, setOptions] = useState<Benchmark[] | null>(null)
  const open = () => {
    if (options) return
    apiFetch<BenchmarkListResponse>('/benchmarks?status=ready&limit=50')
      .then((d) => setOptions(d?.benchmarks ?? []))
      .catch(() => setOptions([]))
  }
  const candidates = (options ?? []).filter((b) => !ids.includes(b.id))
  if (ids.length >= VIEW_LIMIT) return null
  return (
    <select
      aria-label="Add a benchmark to the comparison"
      className="h-8 max-w-xs rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground"
      value=""
      onFocus={open}
      onMouseDown={open}
      onChange={(e) => e.target.value && onAdd(e.target.value)}
    >
      <option value="">+ Add benchmark to compare…</option>
      {candidates.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      {options && candidates.length === 0 && <option disabled>No other ready benchmarks</option>}
    </select>
  )
}

