import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from 'recharts'
import { renameCompressor } from '@/lib/compressors'
import { formatMetricValue, metricLabel } from '@/lib/format'
import { isLowerBetter } from '@/lib/metrics'
import { paretoFront } from '@/lib/pareto'
import { useIsDark } from '@/lib/theme'
import { LegendMarker, MarkerShape } from '@/components/charts/CompressorMarker'
import { LegendRow, TooltipCard } from '@/components/charts/chrome'
import { animationProps, AXIS_PROPS, BAR_CURSOR, GRID_PROPS, LINE_CURSOR } from '@/lib/chart-style'
import { BENCHMARK_COLORS_DARK, BENCHMARK_COLORS_LIGHT, HORIZONTAL_THRESHOLD, MAX_GROUPED_SERIES } from '@/lib/charts'

const fmt = (metric: string) => (v: unknown) => (typeof v === 'number' ? formatMetricValue(v, metric) : String(v ?? '–'))
const FALLBACK = '#64748b'
/** Bars stay thin (≤ 24px) and leave the rest of their slot as air. */
const BAR_SIZE = 24
/** 4px rounded data end, square at the baseline. */
const radius = (horizontal: boolean): [number, number, number, number] => (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0])

export interface BarRow {
  compressor: string
  value: number
}

/** One bar per compressor, coloured like the compressor, its marker at the bar end. */
export function MetricBarChart({ rows, metric, colors, shapes, reference }: {
  rows: BarRow[]
  metric: string
  colors: Map<string, string>
  /** Marker shape per compressor, drawn at the end of each bar. */
  shapes?: Map<string, string>
  reference?: { y: number; label: string }
}) {
  if (rows.length === 0) return null
  const data = rows.map((r) => ({ ...r, name: renameCompressor(r.compressor) }))
  const horizontal = data.length > HORIZONTAL_THRESHOLD
  const height = horizontal ? Math.max(240, data.length * 28 + 60) : 360
  const anim = animationProps()
  return (
    <div style={{ height }} data-testid={`bar-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: 8, right: horizontal ? 32 : 24, top: 24, bottom: horizontal ? 8 : 90 }}>
          <CartesianGrid {...GRID_PROPS} vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" tickFormatter={fmt(metric)} {...AXIS_PROPS} axisLine={false} />
              <YAxis type="category" dataKey="name" width={170} interval={0} {...AXIS_PROPS} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} {...AXIS_PROPS} />
              <YAxis tickFormatter={fmt(metric)} width={80} {...AXIS_PROPS} axisLine={false} />
            </>
          )}
          <Tooltip
            cursor={BAR_CURSOR}
            content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined
              if (!d) return null
              const color = colors.get(d.compressor) ?? FALLBACK
              return (
                <TooltipCard
                  rows={[{ key: d.compressor, name: d.name, value: formatMetricValue(d.value, metric), color, marker: <LegendMarker name={d.compressor} color={color} shape={shapes?.get(d.compressor)} size={12} /> }]}
                  footer={reference ? `${reference.label}: ${formatMetricValue(reference.y, metric)}` : undefined}
                />
              )
            }}
          />
          {reference && (
            horizontal
              ? <ReferenceLine x={reference.y} stroke={FALLBACK} strokeDasharray="4 4" label={{ value: reference.label, fontSize: 11, fill: FALLBACK, position: 'top' }} />
              : <ReferenceLine y={reference.y} stroke={FALLBACK} strokeDasharray="4 4" label={{ value: reference.label, fontSize: 11, fill: FALLBACK, position: 'insideTopRight' }} />
          )}
          <Bar
            dataKey="value"
            name={metricLabel(metric)}
            maxBarSize={BAR_SIZE}
            radius={radius(horizontal)}
            activeBar={{ fillOpacity: 0.85 }}
            {...anim}
            // The compressor's marker at the end of the bar: bars that share a
            // colour stay distinguishable by shape.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label={(props: any) => {
              const d = data[props.index]
              if (!d || props.x == null) return <g />
              const cx = horizontal ? props.x + props.width + 10 : props.x + props.width / 2
              const cy = horizontal ? props.y + props.height / 2 : props.y - 10
              return <MarkerShape cx={cx} cy={cy} r={4.5} ring name={d.compressor} shape={shapes?.get(d.compressor)} color={colors.get(d.compressor) ?? FALLBACK} />
            }}
          >
            {data.map((d) => <Cell key={d.compressor} fill={colors.get(d.compressor) ?? FALLBACK} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Compressors on the axis, one bar per benchmark (at most one per palette slot). */
export function GroupedBarChart({ compressors, series, metric }: {
  compressors: string[]
  series: { id: string; name: string; values: Map<string, number> }[]
  metric: string
}) {
  const dark = useIsDark()
  if (compressors.length === 0 || series.length === 0) return null
  const palette = dark ? BENCHMARK_COLORS_DARK : BENCHMARK_COLORS_LIGHT
  // Colours are never cycled: past the palette, the table carries the rest.
  const shown = series.slice(0, MAX_GROUPED_SERIES)
  const colorOf = (i: number) => palette[i]
  const data = compressors.map((c) => {
    const point: Record<string, string | number> = { name: renameCompressor(c) }
    for (const s of shown) {
      const v = s.values.get(c)
      if (v != null) point[s.id] = v
    }
    return point
  })
  const horizontal = compressors.length > HORIZONTAL_THRESHOLD
  const barSize = shown.length > 4 ? 14 : 20
  const height = horizontal ? Math.max(260, compressors.length * (12 + (barSize + 2) * shown.length) + 80) : 380
  const anim = animationProps()
  return (
    <div data-testid={`grouped-${metric}`} className="space-y-2">
      <LegendRow items={shown.map((s, i) => ({ key: s.id, label: s.name, color: colorOf(i) }))} />
      {series.length > shown.length && (
        <p className="text-center text-xs text-muted-foreground">Showing the first {shown.length} of {series.length} benchmarks; the table below lists all of them.</p>
      )}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} barGap={2} margin={{ left: 8, right: horizontal ? 32 : 24, top: 8, bottom: horizontal ? 8 : 90 }}>
            <CartesianGrid {...GRID_PROPS} vertical={horizontal} horizontal={!horizontal} />
            {horizontal ? (
              <>
                <XAxis type="number" tickFormatter={fmt(metric)} {...AXIS_PROPS} axisLine={false} />
                <YAxis type="category" dataKey="name" width={170} interval={0} {...AXIS_PROPS} />
              </>
            ) : (
              <>
                <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} {...AXIS_PROPS} />
                <YAxis tickFormatter={fmt(metric)} width={80} {...AXIS_PROPS} axisLine={false} />
              </>
            )}
            <Tooltip
              cursor={BAR_CURSOR}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <TooltipCard
                    title={label}
                    rows={shown.flatMap((s, i) => {
                      const v = payload.find((p) => p.dataKey === s.id)?.value
                      return typeof v === 'number' ? [{ key: s.id, name: s.name, value: formatMetricValue(v, metric), color: colorOf(i) }] : []
                    })}
                  />
                )
              }}
            />
            {shown.map((s, i) => (
              <Bar key={s.id} dataKey={s.id} name={s.name} fill={colorOf(i)} maxBarSize={barSize} radius={radius(horizontal)} activeBar={{ fillOpacity: 0.85 }} {...anim} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export interface ScatterRow {
  compressor: string
  /** compression_ratio (raw, plotted as %). */
  ratio: number
  value: number
}

/**
 * Metric vs compression ratio, one marker per compressor (family shape +
 * colour). With `front`, the Pareto front (min ratio, max metric) is drawn.
 */
export function MetricScatterChart({ rows, metric, colors, shapes, front = false }: {
  rows: ScatterRow[]
  metric: string
  colors: Map<string, string>
  shapes?: Map<string, string>
  front?: boolean
}) {
  if (rows.length === 0) return null
  const points = rows
    .map((r) => ({
      compressor: r.compressor,
      name: renameCompressor(r.compressor),
      x: r.ratio * 100,
      y: r.value,
      color: colors.get(r.compressor) ?? FALLBACK,
      shape: shapes?.get(r.compressor),
    }))
    .sort((a, b) => a.x - b.x)
  const frontPoints = front ? paretoFront(points) : []
  const onFront = new Set(frontPoints.map((p) => p.compressor))
  return (
    <div data-testid={`scatter-${metric}`}>
      <div className="h-[420px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ left: 8, right: 24, top: 16, bottom: 36 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, 'auto']}
              tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              label={{ value: 'Compression ratio (%), lower is better', position: 'bottom', offset: 16, fontSize: 12 }}
              {...AXIS_PROPS}
            />
            <YAxis dataKey="y" type="number" domain={[0, 'auto']} tickFormatter={fmt(metric)} width={80} {...AXIS_PROPS} axisLine={false} />
            <Tooltip
              // Item mode: ComposedChart defaults to axis mode, which shows the
              // point nearest the cursor's x anywhere in the plot.
              shared={false}
              cursor={false}
              content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as (typeof points)[number] | undefined) : undefined
                if (!p) return null
                return (
                  <TooltipCard
                    title={<span className="flex items-center gap-1.5"><LegendMarker name={p.compressor} color={p.color} shape={p.shape} size={12} />{p.name}</span>}
                    rows={[
                      { key: 'ratio', name: 'Ratio', value: `${p.x.toFixed(2)}%`, color: p.color, marker: <span className="w-3" /> },
                      { key: 'metric', name: metricLabel(metric), value: formatMetricValue(p.y, metric), color: p.color, marker: <span className="w-3" /> },
                    ]}
                    footer={front && onFront.has(p.compressor) ? 'On the Pareto front' : undefined}
                  />
                )
              }}
            />
            {front && frontPoints.length > 1 && (
              <Line data={frontPoints} dataKey="y" type="stepAfter" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
            )}
            <Scatter
              data={points}
              isAnimationActive={false}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              shape={(props: any) => (
                <g>
                  {/* Invisible hit area, larger than the marker. */}
                  <circle cx={props.cx} cy={props.cy} r={10} fill="transparent" />
                  <MarkerShape cx={props.cx} cy={props.cy} r={6.5} ring name={props.payload?.compressor ?? ''} color={props.payload?.color ?? FALLBACK} shape={props.payload?.shape} />
                </g>
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-1">
        {points.map((p) => (
          <span key={p.compressor} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LegendMarker name={p.compressor} color={p.color} shape={p.shape} />{p.name}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Metric vs chunk size, one smooth line per compressor with its marker on every point. */
export function SweepChart({ chunkLabels, lines, metric, colors, shapes }: {
  chunkLabels: string[]
  lines: { compressor: string; values: (number | null)[] }[]
  metric: string
  colors: Map<string, string>
  shapes?: Map<string, string>
}) {
  if (lines.length === 0) return null
  const data = chunkLabels.map((label, i) => {
    const point: Record<string, string | number | null> = { chunk: label }
    for (const l of lines) point[l.compressor] = l.values[i]
    return point
  })
  const lower = isLowerBetter(metric)
  const anim = animationProps()
  const marker = (compressor: string, r: number) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) => (props.cx == null || props.value == null ? <g key={props.key} /> : (
      <g key={props.key}><MarkerShape cx={props.cx} cy={props.cy} r={r} ring name={compressor} shape={shapes?.get(compressor)} color={colors.get(compressor) ?? FALLBACK} /></g>
    ))
  return (
    <div className="h-[340px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 8, right: 24, top: 12, bottom: 24 }}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis dataKey="chunk" {...AXIS_PROPS} padding={{ left: 16, right: 16 }} label={{ value: 'Chunk size (samples)', position: 'bottom', offset: 6, fontSize: 12 }} />
          <YAxis tickFormatter={fmt(metric)} width={80} {...AXIS_PROPS} axisLine={false} />
          <Tooltip
            cursor={LINE_CURSOR}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              // Best first, so the readout matches the ranking direction.
              const rows = payload
                .filter((p) => typeof p.value === 'number')
                .sort((a, b) => (lower ? Number(a.value) - Number(b.value) : Number(b.value) - Number(a.value)))
                .map((p) => {
                  const c = String(p.dataKey)
                  const color = colors.get(c) ?? FALLBACK
                  return { key: c, name: renameCompressor(c), value: formatMetricValue(Number(p.value), metric), color, marker: <LegendMarker name={c} color={color} shape={shapes?.get(c)} size={12} /> }
                })
              return <TooltipCard title={`Chunk size ${label}`} rows={rows} footer={lower ? 'Lower is better' : 'Higher is better'} />
            }}
          />
          {lines.map((l) => (
            <Line
              key={l.compressor}
              dataKey={l.compressor}
              name={renameCompressor(l.compressor)}
              type="monotone"
              stroke={colors.get(l.compressor) ?? FALLBACK}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={marker(l.compressor, 4)}
              activeDot={marker(l.compressor, 5.5)}
              connectNulls
              {...anim}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
