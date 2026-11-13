import type { ReactNode } from 'react'

/**
 * Shared chart chrome: one tooltip and one legend for every Recharts chart,
 * styled with the theme tokens so they follow light and dark (axis, grid and
 * cursor settings live in lib/chart-style.ts).
 */

export interface TooltipRow {
  key: string
  name: ReactNode
  value: string
  color: string
  /** Key drawn before the name: a short stroke (lines, default) or a marker. */
  marker?: ReactNode
}

/**
 * Tooltip card: the hovered category on top, then one row per series with the
 * value in strong ink and the series name in secondary ink.
 */
export function TooltipCard({ title, rows, footer }: { title?: ReactNode; rows: TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="pointer-events-none min-w-[10rem] max-w-[22rem] rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground">
      {title != null && <p className="mb-1.5 font-medium">{title}</p>}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            {r.marker ?? <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.name}</span>
            <span className="font-mono font-medium tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
      {footer && <p className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">{footer}</p>}
    </div>
  )
}

/** Legend row: a swatch in the series colour beside a label in text ink. */
export function LegendRow({ items, swatch = 'rect' }: { items: { key: string; label: ReactNode; color: string }[]; swatch?: 'rect' | 'line' }) {
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={swatch === 'rect' ? 'h-2.5 w-2.5 rounded-sm' : 'h-0.5 w-3 rounded-full'}
            style={{ backgroundColor: it.color }}
          />
          {it.label}
        </li>
      ))}
    </ul>
  )
}
