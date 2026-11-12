import { getCompressorShape } from '@/lib/compressors'

/**
 * Compressor marker as raw SVG (for use inside Recharts' SVG): the shape
 * encodes the family (spec §6.4), the colour the compressor/instance.
 */
export function MarkerShape({ cx, cy, name, color, r = 6 }: { cx: number; cy: number; name: string; color: string; r?: number }) {
  switch (getCompressorShape(name)) {
    case 'square':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={color} />
    case 'diamond':
      return <polygon points={`${cx},${cy - r * 1.4} ${cx + r * 1.4},${cy} ${cx},${cy + r * 1.4} ${cx - r * 1.4},${cy}`} fill={color} />
    case 'triangle-up':
      return <polygon points={`${cx},${cy - r * 1.5} ${cx + r * 1.4},${cy + r} ${cx - r * 1.4},${cy + r}`} fill={color} />
    case 'star':
      return <polygon points={polygon(cx, cy, r * 1.5, 5, 2)} fill={color} />
    case 'pentagon':
      return <polygon points={polygon(cx, cy, r * 1.3, 5, 1)} fill={color} />
    case 'cross': {
      const w = r * 0.55
      const l = r * 1.35
      return (
        <polygon
          points={`${cx - w},${cy - l} ${cx + w},${cy - l} ${cx + w},${cy - w} ${cx + l},${cy - w} ${cx + l},${cy + w} ${cx + w},${cy + w} ${cx + w},${cy + l} ${cx - w},${cy + l} ${cx - w},${cy + w} ${cx - l},${cy + w} ${cx - l},${cy - w} ${cx - w},${cy - w}`}
          fill={color}
        />
      )
    }
    default:
      return <circle cx={cx} cy={cy} r={r} fill={color} />
  }
}

function polygon(cx: number, cy: number, radius: number, points: number, step: number): string {
  const pts: string[] = []
  for (let i = 0; i < points; i++) {
    const a = (i * step * 2 * Math.PI) / points - Math.PI / 2
    pts.push(`${cx + radius * Math.cos(a)},${cy + radius * Math.sin(a)}`)
  }
  return pts.join(' ')
}

/** Marker in HTML context (legends, filters). */
export function LegendMarker({ name, color }: { name: string; color: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" className="shrink-0" aria-hidden="true">
      <MarkerShape cx={7} cy={7} name={name} color={color} />
    </svg>
  )
}

/** Recharts `shape` renderer: reads `compressor` and `color` from the point. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ScatterMarker(props: any) {
  return (
    <MarkerShape
      cx={props.cx}
      cy={props.cy}
      name={props.payload?.compressor ?? ''}
      color={props.payload?.color ?? '#64748b'}
    />
  )
}
