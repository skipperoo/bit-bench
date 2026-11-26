import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Download, Eye, EyeOff, Maximize2, MoreHorizontal, Share, X, SlidersHorizontal } from 'lucide-react'
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
import { assignCompressorStyles, registerCompressorColors, renameCompressor, shapeKey } from '@/lib/compressors'
import { useChartStyles } from '@/stores/chart-styles-store'
import { useAuthStore } from '@/stores/auth-store'
import ShareDialog from '@/components/ShareDialog'
import { Sheet } from '@/components/ui/sheet'
import { useIsPhone } from '@/lib/responsive'
import { SharedLinkError, sharedFetch } from '@/lib/shares'
import { usePackageColors } from '@/lib/package-colors'
import { formatMetricValue, metricLabel } from '@/lib/format'
import { availableMetrics, metricValue, withDerivedMetrics } from '@/lib/metrics'
import type { MetricDef, MetricGroup } from '@/lib/metrics'
import { METRIC_GROUP_LABELS } from '@/lib/metrics'
import { averageResults, paretoRanking } from '@/lib/pareto'
import { detectSweep, orderByChunkSize } from '@/lib/sweep'
import { allResultsCSV, downloadText } from '@/lib/csv'
import { VIEW_LIMIT, dataSourceText, experimentName, signalEntry, viewPath, withSignals } from '@/lib/experiments'
import { isActive } from '@/lib/status'
import type { Benchmark, BenchmarkDetailResponse, BenchmarkListResponse, BenchmarkResult, SeriesResults, SharedPage } from '@/types'

const GROUP_LABELS = METRIC_GROUP_LABELS

interface Loaded {
  benchmark: Benchmark
  results: BenchmarkResult[]
}

/** Loads the benchmarks in `ids`, or every benchmark of a shared link. */
function useExperimentData(ids: string[], shareToken?: string) {
  const [items, setItems] = useState<Loaded[]>([])
  const [missing, setMissing] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [shared, setShared] = useState<SharedPage | null>(null)
  const [linkError, setLinkError] = useState(0)
  const key = ids.join(',')

  const load = useCallback(async (only?: string[]) => {
    if (shareToken) {
      try {
        const page = await sharedFetch<SharedPage>(shareToken)
        setShared(page)
        setItems((page.benchmarks ?? []).map((d) => ({ benchmark: d.benchmark, results: withDerivedMetrics(d.results ?? []) })))
      } catch (err) {
        setLinkError(err instanceof SharedLinkError ? err.status : 500)
      }
      setLoading(false)
      return
    }
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
  }, [key, shareToken])

  useEffect(() => { setLoading(true); setItems([]); load() }, [load])

  // Refresh running benchmarks until they finish.
  const active = items.filter((i) => isActive(i.benchmark.status)).map((i) => i.benchmark.id).join(',')
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => load(active.split(',')), 3000)
    return () => clearInterval(timer)
  }, [active, load])

  return { items, missing, loading, reload: load, shared, linkError }
}

/**
 * Results of one or more benchmarks. With `shareToken` it is the read-only page
 * of a shared link: nothing is saved, benchmarks can be hidden but not added
 * or removed, and running benchmarks show no task monitor.
 */
export default function ExperimentView({ shareToken }: { shareToken?: string } = {}) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const urlIds = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, VIEW_LIMIT), [params])
  const { items: allItems, missing, loading, reload, shared, linkError } = useExperimentData(urlIds, shareToken)
  const ids = shareToken ? allItems.map((i) => i.benchmark.id) : urlIds
  const [hiddenBenchmarks, setHiddenBenchmarks] = useState<Set<string>>(new Set())
  const items = allItems.filter((i) => !hiddenBenchmarks.has(i.benchmark.id))
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [paretoTarget, setParetoTarget] = useState('')
  const [sharing, setSharing] = useState(false)
  const phone = useIsPhone()
  // Phones: page actions in a sheet from ⋯, the compressor filter in a sheet from a floating button.
  const [actionsOpen, setActionsOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  // Phones: one chart full screen (pinch zoom is off).
  const [expanded, setExpanded] = useState<string | null>(null)
  usePackageColors(!shareToken)
  // A shared page starts from the owner's styles once; later polls keep the viewer's edits.
  const sharedStyles = useRef(false)
  useEffect(() => {
    if (!shared || sharedStyles.current) return
    sharedStyles.current = true
    registerCompressorColors(shared.package_colors ?? {})
    useChartStyles.getState().useLocal(shared.chart_styles ?? {})
  }, [shared])

  const ready = orderByChunkSize(items.filter((i) => i.benchmark.status === 'ready' && i.results.length > 0), (i) => i.benchmark)
  // "Aggregate time series" off (URL signals=split): every signal of each
  // benchmark beside its aggregate. Per-signal results are loaded on demand.
  const aggregate = params.get('signals') !== 'split'
  const splittable = ready.some((i) => (i.benchmark.file_count ?? 1) > 1)
  const [seriesById, setSeriesById] = useState<Map<string, SeriesResults[]>>(new Map())
  const loadSeries = useCallback(async (benchmarkIds: string[]) => {
    const known = new Map(seriesById)
    const fetched = await Promise.all(benchmarkIds.filter((id) => !known.has(id)).map(async (id) =>
      [id, (await (shareToken
        ? sharedFetch<{ series: SeriesResults[] }>(`${shareToken}/series/${id}`)
        : apiFetch<{ series: SeriesResults[] }>(`/benchmarks/${id}/series`)))?.series ?? []] as const))
    if (fetched.length === 0) return known
    for (const [id, s] of fetched) known.set(id, s)
    setSeriesById(known)
    return known
  }, [seriesById, shareToken])
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
  useEffect(() => { if (!shareToken) useChartStyles.getState().load() }, [shareToken])
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

  if (linkError === 401) return <Navigate to={`/login?next=${encodeURIComponent(`/s/${shareToken}`)}`} replace />
  if (linkError) return <p className="text-muted-foreground">This link is not available. Ask the person who shared it for a new one.</p>
  if (!shareToken && ids.length === 0) return <p className="text-muted-foreground">No benchmark selected. <Link className="underline" to="/experiments">Back to experiments</Link></p>
  if (loading) return <p className="text-muted-foreground">Loading…</p>
  if (items.length === 0) return <p className="text-destructive">Benchmark not found.</p>

  const single = items.length === 1 ? items[0].benchmark : null
  const title = single ? single.name : experimentName(items.map((i) => i.benchmark.name))
  const instances = Array.from(new Map(items.flatMap((i) => i.benchmark.compressors).map((c) => [c.label, c])).values())
  const notReady = items.filter((i) => i.benchmark.status !== 'ready')
  const myId = useAuthStore.getState().getUserID()
  const canShare = !shareToken && !!myId && allItems.every((i) => i.benchmark.user_id === myId)

  const valueOf = (benchmarkId: string, compressor: string, metric: string) => {
    const item = visible.find((v) => v.benchmark.id === benchmarkId)
    const r = item?.results.find((x) => x.compressor === compressor)
    return r ? metricValue(r, metric) ?? null : null
  }

  // The chart of a metric; `tall` is the full-screen version (phones).
  const chartFor = (m: MetricDef, tall = false) => {
    if (multi) {
      return (
        <GroupedBarChart
          compressors={visibleNames}
          metric={m.key}
          tall={tall}
          series={visible.map((v) => ({
            id: v.benchmark.id,
            name: v.benchmark.name,
            values: new Map(v.results.map((r) => [r.compressor, metricValue(r, m.key)]).filter((e): e is [string, number] => e[1] != null)),
          }))}
        />
      )
    }
    const results = visible[0]?.results ?? []
    const present = results.filter((r) => metricValue(r, m.key) != null)
    const uncompressedRef = m.key === 'bits_per_element' ? results.find((r) => r.uncompressed_bits_per_element != null)?.uncompressed_bits_per_element : undefined
    return m.chart === 'bar' ? (
      <MetricBarChart
        rows={present.map((r) => ({ compressor: r.compressor, value: metricValue(r, m.key)! }))}
        metric={m.key}
        colors={colors} shapes={shapes}
        tall={tall}
        reference={uncompressedRef != null ? { y: uncompressedRef, label: `input container ${uncompressedRef.toFixed(0)} b/e` } : undefined}
      />
    ) : (
      <MetricScatterChart
        rows={present.filter((r) => r.compression_ratio != null).map((r) => ({ compressor: r.compressor, ratio: r.compression_ratio!, value: metricValue(r, m.key)! }))}
        metric={m.key}
        colors={colors} shapes={shapes}
        tall={tall}
      />
    )
  }
  const cardHeader = (m: MetricDef) => (
    <CardHeader className={phone ? 'flex-row items-center justify-between space-y-0' : undefined}>
      <CardTitle className="text-base">{metricLabel(m.key)}</CardTitle>
      {phone && (
        <button type="button" aria-label={`Full screen: ${metricLabel(m.key)}`} onClick={() => setExpanded(m.key)}
          className="-m-1 rounded-md p-1.5 text-muted-foreground active:bg-secondary">
          <Maximize2 className="h-4 w-4" />
        </button>
      )}
    </CardHeader>
  )

  const metricCard = (m: MetricDef) => {
    if (multi) {
      return (
        <Card key={m.key}>
          {cardHeader(m)}
          <CardContent className="space-y-4">
            {chartFor(m)}
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
    return (
      <Card key={m.key}>
        {cardHeader(m)}
        <CardContent className="space-y-4">
          {chartFor(m)}
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
  // Several benchmarks: the Pareto view defaults to every compressor averaged over all of them.
  const paretoAverage = multi && !visible.some((v) => v.benchmark.id === paretoTarget)
  const paretoResults = paretoAverage
    ? averageResults(ready.map((i) => i.results.filter((r) => !hidden.has(r.compressor))))
    : paretoItem?.results ?? []
  const topFive = paretoRanking(paretoResults).slice(0, 5)

  return (
    // Phones: room below the last card for the floating compressor button.
    <div className="space-y-5 max-md:pb-14">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight max-md:min-w-0 max-md:flex-1 max-md:text-xl max-md:break-words">{title}</h1>
          {single && <StatusPill status={single.status} progress={single.progress} />}
          {phone && ready.length > 0 && (
            <Button variant="ghost" size="sm" aria-label="More actions" onClick={() => setActionsOpen(true)} className="-mr-2"><MoreHorizontal className="h-5 w-5" /></Button>
          )}
        </div>
        {shared && (
          <p className="text-xs text-muted-foreground">
            Read-only{shared.owner_email && ` · shared by ${shared.owner_email}`}
            {shared.expires_at && ` · link expires ${new Date(shared.expires_at).toLocaleDateString()}`}
            {' · changes to names, colours and shapes are not saved'}
          </p>
        )}
        {single && allItems.length === 1 ? (
          <p className="text-sm text-muted-foreground">
            {dataSourceText(single)}
            {` · ${new Date(single.created_at).toLocaleString()}`}
            {single.measure_memory === false && ' · memory not measured'}
            {single.source && <span className="block font-mono text-xs truncate" title={single.source.series.join(', ')}>series: {single.source.series.join(', ')}</span>}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2 max-md:-mx-4 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4 max-md:pb-1 max-md:[scrollbar-width:none]" aria-label="Benchmarks in this view">
            {(shareToken ? allItems : items).map((i) => {
              const off = hiddenBenchmarks.has(i.benchmark.id)
              return (
                <li key={i.benchmark.id} className={`flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs max-md:py-1.5 ${off ? 'opacity-50' : ''}`}>
                  {shareToken
                    ? <span className={off ? 'line-through' : ''}>{i.benchmark.name}</span>
                    : <Link to={viewPath([i.benchmark.id])} className="hover:underline">{i.benchmark.name}</Link>}
                  {i.benchmark.status !== 'ready' && <StatusPill status={i.benchmark.status} progress={i.benchmark.progress} />}
                  {shareToken ? (
                    <button
                      type="button"
                      aria-label={`${off ? 'Show' : 'Hide'} ${i.benchmark.name}`}
                      aria-pressed={off}
                      disabled={!off && items.length === 1}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                      onClick={() => setHiddenBenchmarks((prev) => {
                        const next = new Set(prev)
                        if (off) next.delete(i.benchmark.id)
                        else next.add(i.benchmark.id)
                        return next
                      })}
                    >
                      {off ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  ) : (
                    <button type="button" aria-label={`Remove ${i.benchmark.name}`} className="text-muted-foreground hover:text-foreground" onClick={() => removeId(i.benchmark.id)}>
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {!shareToken && <AddBenchmark ids={ids} onAdd={(id) => navigate(viewPath([...ids, id]) + `&tab=${tab}`)} />}
      </div>

      {missing.length > 0 && <p className="text-sm text-destructive">{missing.length} benchmark(s) could not be loaded (deleted or not yours).</p>}

      {!shareToken && notReady.length > 0 && (
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

      {phone && (
        <Sheet open={expanded !== null} onClose={() => setExpanded(null)} title={expanded ? metricLabel(expanded) : ''} className="max-h-[96dvh]">
          {expanded && metrics.some((m) => m.key === expanded) && chartFor(metrics.find((m) => m.key === expanded)!, true)}
          <p className="mt-2 text-center text-xs text-muted-foreground">Turn your phone sideways for a wider chart.</p>
        </Sheet>
      )}
      <ShareDialog open={sharing} benchmarkIds={ids} title={title} tab={tab} onClose={() => setSharing(false)} />

      {ready.length === 0 ? null : (
        <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
          {phone ? (
            <>
              <button type="button" onClick={() => setFilterOpen(true)}
                // Shared links have no tab bar to clear.
                className={`fixed right-4 z-20 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-transform active:scale-95 ${shareToken ? 'bottom-[calc(1rem+env(safe-area-inset-bottom))]' : 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]'}`}>
                <SlidersHorizontal className="h-4 w-4" />Compressors {visibleNames.length}/{allNames.length}
              </button>
              <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Show compressors"
                footer={<Button className="w-full" onClick={() => setFilterOpen(false)}>Done</Button>}>
                <InstanceFilter names={allNames} colors={colors} shapes={shapes} hidden={hidden} onChange={setHidden} styleEditing={styleEditing} />
              </Sheet>
              <Sheet open={actionsOpen} onClose={() => setActionsOpen(false)} title="Actions">
                <div className="space-y-1">
                  {canShare && (
                    <button type="button" onClick={() => { setActionsOpen(false); setSharing(true) }} className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left active:bg-secondary">
                      <Share className="h-5 w-5 text-muted-foreground" />Share
                    </button>
                  )}
                  <button type="button" onClick={() => { setActionsOpen(false); downloadAll() }} className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left active:bg-secondary">
                    <Download className="h-5 w-5 text-muted-foreground" />Download all results (CSV)
                  </button>
                  {splittable && (
                    <label htmlFor="aggregate-signals-phone" className="flex items-start justify-between gap-3 px-2 py-3">
                      <span>
                        Aggregate time series
                        <span className="block text-xs text-muted-foreground">{aggregate ? 'One result per benchmark over all its signals.' : 'Every signal on its own after the aggregate.'}</span>
                      </span>
                      <Switch id="aggregate-signals-phone" checked={aggregate} onCheckedChange={setAggregate} />
                    </label>
                  )}
                </div>
              </Sheet>
            </>
          ) : (
          <aside className="lg:sticky lg:top-16 lg:self-start">
            <details className="lg:hidden rounded-md border border-border p-3">
              <summary className="flex items-center gap-2 text-sm cursor-pointer"><SlidersHorizontal className="w-4 h-4" />Filter compressors ({visibleNames.length}/{allNames.length})</summary>
              <div className="mt-3"><InstanceFilter names={allNames} colors={colors} shapes={shapes} hidden={hidden} onChange={setHidden} styleEditing={styleEditing} /></div>
            </details>
            <div className="hidden lg:block rounded-md border border-border p-3 max-h-[calc(100vh-6rem)] overflow-y-auto">
              <InstanceFilter names={allNames} colors={colors} shapes={shapes} hidden={hidden} onChange={setHidden} styleEditing={styleEditing} />
            </div>
          </aside>
          )}

          <div className="space-y-4 min-w-0">
            {!phone && splittable && (
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
            {/* Phones: the section strip scrolls sideways and sticks under the status bar. */}
            <div className="max-md:sticky max-md:top-[env(safe-area-inset-top)] max-md:z-10 max-md:-mx-4 max-md:bg-background max-md:px-4">
              <Tabs items={tabItems} value={tab} onChange={setTab} ariaLabel="Result sections" idPrefix="exp"
                className="max-md:flex-nowrap max-md:overflow-x-auto max-md:[scrollbar-width:none]" />
            </div>
            {visibleNames.length === 0 ? (
              <p className="text-sm text-muted-foreground">Every compressor is hidden by the filter.</p>
            ) : (
              <TabPanel value={tab} idPrefix="exp" className="space-y-4">
                {tab === 'overview' && (
                  <>
                    {!phone && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>Every metric of every benchmark, signal and compressor in one file; each metric's table also has its own CSV.</span>
                      <div className="flex flex-wrap gap-2">
                        {canShare && (
                          <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
                            <Share className="mr-1 h-4 w-4" />Share
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={downloadAll}>
                          <Download className="mr-1 h-4 w-4" />Download all results (CSV)
                        </Button>
                      </div>
                    </div>}
                    {!multi && topFive.length > 0 && <TopFive entries={topFive} results={paretoItem!.results} colors={colors} shapes={shapes} />}
                    {metrics.filter((m) => m.key === 'compression_ratio').map(metricCard)}
                  </>
                )}
                {groups.includes(tab as MetricGroup) && metrics.filter((m) => m.group === tab).map(metricCard)}
                {tab === 'pareto' && paretoItem && (
                  <>
                    {multi && (
                      <div className="space-y-1">
                        <label className="flex min-w-0 items-center gap-2 text-sm">
                          <span className="shrink-0">Benchmark</span>
                          <select className="h-8 w-full min-w-0 max-w-md truncate rounded-md border border-input bg-transparent px-2 text-sm"
                            value={paretoAverage ? 'average' : paretoItem.benchmark.id} onChange={(e) => setParetoTarget(e.target.value)}>
                            <option value="average">Average of all {ready.length} benchmarks</option>
                            {visible.map((v) => <option key={v.benchmark.id} value={v.benchmark.id}>{v.benchmark.name}</option>)}
                          </select>
                        </label>
                      </div>
                    )}
                    <TopFive entries={topFive} results={paretoResults} colors={colors} shapes={shapes} />
                    {(['compression_throughput_mbs', 'decompression_throughput_mbs'] as const).map((key) => {
                      const rows = paretoResults
                        .filter((r) => r.compression_ratio != null && metricValue(r, key) != null)
                        .map((r) => ({ compressor: r.compressor, ratio: r.compression_ratio!, value: metricValue(r, key)! }))
                      return rows.length ? (
                        <Card key={key}>
                          <CardHeader><CardTitle className="text-base">{metricLabel(key)} vs ratio</CardTitle></CardHeader>
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
  const phone = useIsPhone()
  if (phone) {
    // Phones: one row per compressor, the numbers on a second line.
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Top 5 <span className="font-normal text-muted-foreground">· ratio vs compression speed</span></CardTitle></CardHeader>
        <CardContent>
          <ol className="divide-y divide-border">
            {entries.map((e, i) => {
              const r = results.find((x) => x.compressor === e.compressor)
              return (
                <li key={e.compressor} className="flex gap-3 py-2">
                  <span className="w-4 pt-0.5 text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm">
                      <CompressorSwatch name={e.compressor} color={colors.get(e.compressor)} shape={shapes?.get(e.compressor)} />
                      <span className="truncate font-mono">{renameCompressor(e.compressor)}</span>
                      <SelfTestBadge failures={r?.self_test_failures} />
                      {e.dominationCount === 0 && <span className="ml-auto shrink-0 rounded border border-green-200 bg-green-100 px-1.5 text-[11px] text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200">Pareto</span>}
                    </div>
                    <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {r?.compression_ratio != null ? formatMetricValue(r.compression_ratio, 'compression_ratio') : '–'}
                      {' · '}{r?.compression_throughput_mbs != null ? `${r.compression_throughput_mbs.toFixed(1)} MB/s` : '–'}
                      {' · '}{r?.bits_per_element != null ? `${r.bits_per_element.toFixed(2)} b/e` : '–'}
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        </CardContent>
      </Card>
    )
  }
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

