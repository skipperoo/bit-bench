import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SweepChart } from '@/components/charts/MetricCharts'
import { metricLabel } from '@/lib/format'
import { isLowerBetter, METRIC_GROUP_LABELS } from '@/lib/metrics'
import type { MetricDef, MetricGroup } from '@/lib/metrics'
import { chunkLabel } from '@/lib/sweep'
import type { Sweep } from '@/lib/sweep'

/**
 * Every metric against chunk size, one line per compressor. Metrics can be
 * switched off with the chips above the charts (grouped like the result
 * tabs). With one transform the metric charts share a grid; with several,
 * each metric gets a row with one chart per transform.
 */
export default function SweepPanel({ sweep, metrics, compressors, colors, shapes, value, hidden, onHiddenChange }: {
  sweep: Sweep
  metrics: MetricDef[]
  compressors: string[]
  colors: Map<string, string>
  shapes: Map<string, string>
  value: (benchmarkId: string, compressor: string, metric: string) => number | null
  /** Metrics switched off by the user. */
  hidden: Set<string>
  onHiddenChange: (hidden: Set<string>) => void
}) {
  const groups = (Object.keys(METRIC_GROUP_LABELS) as MetricGroup[])
    .map((g) => ({ group: g, members: metrics.filter((m) => m.group === g) }))
    .filter((g) => g.members.length > 0)
  const shown = metrics.filter((m) => !hidden.has(m.key))
  const toggle = (keys: string[], visible: boolean) => {
    const next = new Set(hidden)
    for (const k of keys) {
      if (visible) next.delete(k)
      else next.add(k)
    }
    onHiddenChange(next)
  }
  const single = sweep.transforms.length === 1

  const chart = (metric: string, transform: string) => {
    const points = sweep.byTransform.get(transform)!
    return (
      <SweepChart
        chunkLabels={points.map((p) => chunkLabel(p.chunkSize))}
        metric={metric}
        colors={colors}
        shapes={shapes}
        lines={compressors.map((c) => ({ compressor: c, values: points.map((p) => value(p.benchmark.id, c, metric)) }))}
      />
    )
  }
  const direction = (metric: string) => (
    <span className="text-xs font-normal text-muted-foreground">{isLowerBetter(metric) ? 'lower is better' : 'higher is better'}</span>
  )

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border p-3 space-y-2" role="group" aria-label="Sweep metrics">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <p>
            <span className="font-medium">Metrics</span>{' '}
            <span className="text-muted-foreground">{shown.length}/{metrics.length} · {sweep.dataset}, {sweep.chunkSizes.length} chunk sizes</span>
          </p>
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onHiddenChange(new Set())}>All</button>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onHiddenChange(new Set(metrics.map((m) => m.key)))}>None</button>
          </span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {groups.map(({ group, members }) => {
            const visible = members.filter((m) => !hidden.has(m.key)).length
            return (
              <div key={group} className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  aria-label={`${visible === members.length ? 'Hide' : 'Show'} all ${METRIC_GROUP_LABELS[group]} metrics`}
                  onClick={() => toggle(members.map((m) => m.key), visible < members.length)}
                >
                  {METRIC_GROUP_LABELS[group]}
                </button>
                {members.map((m) => {
                  const on = !hidden.has(m.key)
                  return (
                    <button
                      key={m.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle([m.key], !on)}
                      className={`h-7 rounded-md border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        on ? 'border-foreground bg-secondary text-foreground' : 'border-border text-muted-foreground line-through decoration-1 hover:text-foreground'
                      }`}
                    >
                      {metricLabel(m.key)}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every metric is switched off. Pick one above to plot it.</p>
      ) : single ? (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {shown.map((m) => (
            <Card key={m.key}>
              <CardHeader className="pb-2"><CardTitle className="flex items-baseline justify-between gap-2 text-base">{metricLabel(m.key)}{direction(m.key)}</CardTitle></CardHeader>
              <CardContent>{chart(m.key, sweep.transforms[0])}</CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {shown.map((m) => (
            <section key={m.key} aria-label={metricLabel(m.key)} className="space-y-2">
              <h3 className="flex items-baseline gap-3 text-base font-medium">{metricLabel(m.key)}{direction(m.key)}</h3>
              <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {sweep.transforms.map((t) => (
                  <Card key={t}>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{t}</CardTitle></CardHeader>
                    <CardContent>{chart(m.key, t)}</CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
