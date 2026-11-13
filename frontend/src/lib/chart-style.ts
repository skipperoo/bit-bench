import { prefersReducedMotion } from '@/lib/theme'

/** Shared Recharts settings: recessive axes/grid and theme-neutral cursors. */

/** Axis ticks: muted ink via CSS (index.css), no tick marks. */
export const AXIS_PROPS = { fontSize: 11, tickLine: false, stroke: 'var(--color-border)' } as const

/** Solid hairline grid (index.css gives it the border colour). */
export const GRID_PROPS = { strokeWidth: 1 } as const

/** Bars and lines grow in on first render, unless reduced motion is requested. */
export function animationProps() {
  const off = prefersReducedMotion()
  return { isAnimationActive: !off, animationDuration: 450, animationEasing: 'ease-out' as const }
}

/** Hover band behind the bars of a category: the text colour at a whisper, so it suits both themes. */
export const BAR_CURSOR = { fill: 'currentColor', fillOpacity: 0.05, stroke: 'none' }

/** Crosshair on line charts. */
export const LINE_CURSOR = { stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 1 }
