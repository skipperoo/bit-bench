import { getCompressorShape } from '@/lib/compressors'

/**
 * Compressor marker as raw SVG (for use inside Recharts' SVG): the shape
 * encodes the family (spec §6.4), the colour the compressor/instance.
 */
export function MarkerShape({ cx, cy, name, color, shape, r = 6, ring = false }: {
  cx: number; cy: number; name: string; color: string; shape?: string; r?: number
  /** A 2px ring in the card colour so overlapping markers and lines stay legible. */
  ring?: boolean
}) {
  const paint = ring
    ? { fill: color, style: { stroke: 'var(--color-card)', strokeWidth: 4, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const } }
    : { fill: color }
  switch (shape ?? getCompressorShape(name)) {
    case 'square':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} {...paint} />
    case 'diamond':
      return <polygon points={`${cx},${cy - r * 1.4} ${cx + r * 1.4},${cy} ${cx},${cy + r * 1.4} ${cx - r * 1.4},${cy}`} {...paint} />
    case 'triangle-up':
      return <polygon points={`${cx},${cy - r * 1.5} ${cx + r * 1.4},${cy + r} ${cx - r * 1.4},${cy + r}`} {...paint} />
    case 'star':
      return <polygon points={polygon(cx, cy, r * 1.5, 5, 2)} {...paint} />
    case 'pentagon':
      return <polygon points={polygon(cx, cy, r * 1.3, 5, 1)} {...paint} />
    case 'triangle-down':
      return <polygon points={`${cx},${cy + r * 1.5} ${cx + r * 1.4},${cy - r} ${cx - r * 1.4},${cy - r}`} {...paint} />
    case 'hexagon':
      return <polygon points={polygon(cx, cy, r * 1.25, 6, 1)} {...paint} />
    case 'x': {
      const w = r * 0.45
      const l = r * 1.3
      return (
        <g transform={`rotate(45 ${cx} ${cy})`}>
          <polygon
            points={`${cx - w},${cy - l} ${cx + w},${cy - l} ${cx + w},${cy - w} ${cx + l},${cy - w} ${cx + l},${cy + w} ${cx + w},${cy + w} ${cx + w},${cy + l} ${cx - w},${cy + l} ${cx - w},${cy + w} ${cx - l},${cy + w} ${cx - l},${cy - w} ${cx - w},${cy - w}`}
            {...paint}
          />
        </g>
      )
    }
    case 'cross': {
      const w = r * 0.55
      const l = r * 1.35
      return (
        <polygon
          points={`${cx - w},${cy - l} ${cx + w},${cy - l} ${cx + w},${cy - w} ${cx + l},${cy - w} ${cx + l},${cy + w} ${cx + w},${cy + w} ${cx + w},${cy + l} ${cx - w},${cy + l} ${cx - w},${cy + w} ${cx - l},${cy + w} ${cx - l},${cy - w} ${cx - w},${cy - w}`}
          {...paint}
        />
      )
    }
    default:
      return <circle cx={cx} cy={cy} r={r} {...paint} />
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
export function LegendMarker({ name, color, shape, size = 14 }: { name: string; color: string; shape?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0" aria-hidden="true">
      <MarkerShape cx={7} cy={7} name={name} color={color} shape={shape} r={size < 14 ? 5 : 6} />
    </svg>
  )
}
