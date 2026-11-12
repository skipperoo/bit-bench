import { useEffect, useRef, useState } from 'react'
import { LegendMarker } from '@/components/charts/CompressorMarker'
import { CHART_SHAPES, renameCompressor } from '@/lib/compressors'

const SHAPE_NAMES: Record<string, string> = {
  circle: 'Circle',
  square: 'Square',
  diamond: 'Diamond',
  'triangle-up': 'Triangle',
  'triangle-down': 'Inverted triangle',
  star: 'Star',
  pentagon: 'Pentagon',
  hexagon: 'Hexagon',
  x: 'Cross (×)',
  cross: 'Plus',
}

/**
 * The compressor's chart marker as a button; it opens a grid of every shape
 * drawn in the compressor's colour. Picking the default shape removes the
 * override.
 */
export default function ShapePicker({ name, color, shape, defaultShape, overridden, onChange }: {
  name: string
  color: string
  shape: string
  defaultShape: string
  overridden: boolean
  onChange: (shape: string | null) => void
}) {
  // Viewport position of the open panel; null = closed. The panel is fixed so
  // the scrolling filter sidebar cannot clip it.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const open = pos != null
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = useRef<HTMLButtonElement>(null)
  const label = renameCompressor(name)

  /** Panel position under (or, near the bottom, above) the marker; null when the marker is off screen. */
  const place = () => {
    const r = trigger.current?.getBoundingClientRect()
    if (!r || r.bottom < 0 || r.top > window.innerHeight) return null
    const height = 150
    const width = 200
    const below = r.bottom + 4 + height <= window.innerHeight
    return {
      top: below ? r.bottom + 4 : Math.max(4, r.top - 4 - height),
      left: Math.max(4, Math.min(r.left, window.innerWidth - width - 4)),
    }
  }
  const setOpen = (next: boolean | ((o: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next
    setPos(value ? place() : null)
  }

  useEffect(() => {
    if (!open) return
    current.current?.focus()
    const close = () => setPos(null)
    // Follow the marker while the page or the sidebar scrolls.
    const follow = () => setPos(place())
    const onPointer = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  const pick = (s: string) => {
    setOpen(false)
    if (s === shape) return
    onChange(s === defaultShape ? null : s)
  }

  return (
    <div ref={root} className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        aria-label={`Marker shape of ${label}: ${SHAPE_NAMES[shape] ?? shape}${overridden ? ' (yours)' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Change marker shape"
        onClick={() => setOpen((o) => !o)}
        className={`relative inline-flex h-6 w-6 items-center justify-center rounded-md border hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${open ? 'border-foreground' : 'border-transparent'}`}
      >
        <LegendMarker name={name} color={color} shape={shape} />
        {overridden && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-foreground" />}
      </button>
      {open && (
        <div role="dialog" aria-label={`Marker shape for ${label}`} style={{ top: pos.top, left: pos.left }} className="fixed z-10 w-[12.5rem] rounded-md border border-border bg-background p-2">
          <p className="mb-1.5 truncate font-mono text-xs" title={label}>{label}</p>
          <div className="grid grid-cols-5 gap-1">
            {CHART_SHAPES.map((s) => (
              <button
                key={s}
                ref={s === shape ? current : undefined}
                type="button"
                aria-label={`${SHAPE_NAMES[s]}${s === defaultShape ? ' (default)' : ''}`}
                aria-pressed={s === shape}
                title={`${SHAPE_NAMES[s]}${s === defaultShape ? ' (default)' : ''}`}
                onClick={() => pick(s)}
                className={`relative flex h-8 w-8 items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${s === shape ? 'border-foreground bg-secondary' : 'border-border hover:bg-secondary'}`}
              >
                <LegendMarker name={name} color={color} shape={s} size={16} />
                {s === defaultShape && <span aria-hidden="true" className="absolute bottom-0.5 h-px w-3 bg-muted-foreground" />}
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {overridden ? (
              <button type="button" className="text-foreground underline underline-offset-2" onClick={() => { setOpen(false); onChange(null) }}>
                Use default shape
              </button>
            ) : (
              <span>Underlined = default shape</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
