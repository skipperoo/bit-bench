import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from 'recharts'
import { renameCompressor } from '@/lib/compressors'
import { formatMetricValue, metricLabel } from '@/lib/format'
import { paretoFront } from '@/lib/pareto'
import { LegendMarker, MarkerShape, ScatterMarker } from '@/components/charts/CompressorMarker'
import { BENCHMARK_COLORS, HORIZONTAL_THRESHOLD } from '@/lib/charts'


const fmt = (metric: string) => (v: unknown) => (typeof v === 'number' ? formatMetricValue(v, metric) : String(v ?? '–'))

export interface BarRow {
  compressor: string
  value: number
}

/** One bar per compressor, coloured like the compressor. */
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
  const height = horizontal ? Math.max(240, data.length * 24 + 60) : 360
  return (
    <div style={{ height }} data-testid={`bar-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: 8, right: horizontal ? 32 : 24, top: 24, bottom: horizontal ? 8 : 90 }}>
          <CartesianGrid strokeDasharray="3 3" />
          {horizontal ? (
            <>
              <XAxis type="number" tickFormatter={fmt(metric)} fontSize={11} />
              <YAxis type="category" dataKey="name" width={170} interval={0} fontSize={11} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
              <YAxis tickFormatter={fmt(metric)} width={80} fontSize={11} />
            </>
          )}
          <Tooltip formatter={fmt(metric)} />
          {reference && (
            horizontal
              ? <ReferenceLine x={reference.y} stroke="#64748b" strokeDasharray="4 4" label={{ value: reference.label, fontSize: 11, fill: '#64748b', position: 'top' }} />
              : <ReferenceLine y={reference.y} stroke="#64748b" strokeDasharray="4 4" label={{ value: reference.label, fontSize: 11, fill: '#64748b', position: 'insideTopRight' }} />
          )}
          <Bar
            dataKey="value"
            name={metricLabel(metric)}
            isAnimationActive={false}
            // The compressor's marker at the end of the bar: bars that share a
            // colour stay distinguishable by shape.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label={(props: any) => {
              const d = data[props.index]
              if (!d || props.x == null) return <g />
              const cx = horizontal ? props.x + props.width + 9 : props.x + props.width / 2
              const cy = horizontal ? props.y + props.height / 2 : props.y - 9
              return <MarkerShape cx={cx} cy={cy} r={4.5} name={d.compressor} shape={shapes?.get(d.compressor)} color={colors.get(d.compressor) ?? '#64748b'} />
            }}
          >
            {data.map((d) => <Cell key={d.compressor} fill={colors.get(d.compressor) ?? '#64748b'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Compressors on the axis, one bar per benchmark. */
export function GroupedBarChart({ compressors, series, metric }: {
  compressors: string[]
  series: { id: string; name: string; values: Map<string, number> }[]
  metric: string
}) {
  if (compressors.length === 0 || series.length === 0) return null
  const data = compressors.map((c) => {
    const point: Record<string, string | number> = { name: renameCompressor(c) }
    for (const s of series) {
      const v = s.values.get(c)
      if (v != null) point[s.id] = v
    }
    return point
  })
  const horizontal = compressors.length > HORIZONTAL_THRESHOLD
  const height = horizontal ? Math.max(260, compressors.length * (10 + 8 * series.length) + 80) : 380
  return (
    <div style={{ height }} data-testid={`grouped-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: 8, right: horizontal ? 32 : 24, top: 24, bottom: horizontal ? 8 : 90 }}>
          <CartesianGrid strokeDasharray="3 3" />
          {horizontal ? (
            <>
              <XAxis type="number" tickFormatter={fmt(metric)} fontSize={11} />
              <YAxis type="category" dataKey="name" width={170} interval={0} fontSize={11} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} fontSize={11} />
              <YAxis tickFormatter={fmt(metric)} width={80} fontSize={11} />
            </>
          )}
          <Tooltip formatter={fmt(metric)} />
          {/* itemSorter null: keep the series order (Recharts sorts by name by default). */}
          <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 12 }} itemSorter={null} />
          {series.map((s, i) => (
            <Bar key={s.id} dataKey={s.id} name={s.name} fill={BENCHMARK_COLORS[i % BENCHMARK_COLORS.length]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
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
      color: colors.get(r.compressor) ?? '#64748b',
      shape: shapes?.get(r.compressor),
    }))
    .sort((a, b) => a.x - b.x)
  const frontPoints = front ? paretoFront(points) : []
  return (
    <div data-testid={`scatter-${metric}`}>
      <div className="h-[420px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ left: 8, right: 24, top: 12, bottom: 36 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, 'auto']}
              tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              label={{ value: 'Compression ratio (%) — lower is better', position: 'bottom', offset: 16, fontSize: 12 }}
              fontSize={11}
            />
            <YAxis dataKey="y" type="number" domain={[0, 'auto']} tickFormatter={fmt(metric)} width={80} fontSize={11} />
            <Tooltip
              content={({ active, payload }) => {
                const p = active && payload?.[0]?.payload as (typeof points)[number] | undefined
                if (!p) return null
                return (
                  <div className="rounded-md border border-border bg-background p-2 text-xs">
                    <p className="font-medium font-mono">{p.name}</p>
                    <p>Ratio: {p.x.toFixed(2)}%</p>
                    <p>{metricLabel(metric)}: {formatMetricValue(p.y, metric)}</p>
                  </div>
                )
              }}
            />
            {front && frontPoints.length > 1 && (
              <Line data={frontPoints} dataKey="y" type="stepAfter" stroke="#94a3b8" strokeDasharray="5 4" dot={false} isAnimationActive={false} legendType="none" />
            )}
            <Scatter data={points} shape={ScatterMarker} isAnimationActive={false} />
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

/** Metric vs chunk size, one line per compressor (scaling plots). */
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
  return (
    <div className="h-[340px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 8, right: 24, top: 12, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="chunk" fontSize={11} label={{ value: 'Chunk size (samples)', position: 'bottom', offset: 6, fontSize: 12 }} />
          <YAxis tickFormatter={fmt(metric)} width={80} fontSize={11} />
          <Tooltip formatter={fmt(metric)} />
          {lines.map((l) => (
            <Line
              key={l.compressor}
              dataKey={l.compressor}
              name={renameCompressor(l.compressor)}
              stroke={colors.get(l.compressor) ?? '#64748b'}
              strokeWidth={2}
              // Family marker on every point: colours alone can repeat.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              dot={(props: any) => (props.cx == null || props.value == null ? <g key={props.key} /> : (
                <g key={props.key}><MarkerShape cx={props.cx} cy={props.cy} r={4} name={l.compressor} shape={shapes?.get(l.compressor)} color={colors.get(l.compressor) ?? '#64748b'} /></g>
              ))}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
