import { useEffect, useRef, useState } from 'react'
import { LegendMarker } from '@/components/charts/CompressorMarker'
import { CHART_PALETTE, CHART_SHAPES, defaultCompressorName, renameCompressor } from '@/lib/compressors'

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

const PANEL_WIDTH = 216
const PANEL_HEIGHT = 380

export interface StylePickerProps {
  name: string
  color: string
  shape: string
  defaultColor: string
  defaultShape: string
  shapeOverridden: boolean
  colorOverridden: boolean
  nameOverridden: boolean
  /** `null` restores the default name. */
  onNameChange: (name: string | null) => void
  /** `null` removes the shape override. */
  onShapeChange: (shape: string | null) => void
  /** `null` removes the colour override. */
  onColorChange: (color: string | null) => void
  onReset: () => void
}

/**
 * The compressor's chart marker as a button; it opens a panel with its
 * display name, every marker shape and a set of colours. Picking the default
 * shape or colour, or clearing the name, removes that override.
 */
export default function StylePicker({
  name, color, shape, defaultColor, defaultShape, shapeOverridden, colorOverridden, nameOverridden, onNameChange, onShapeChange, onColorChange, onReset,
}: StylePickerProps) {
  // Viewport position of the open panel; null = closed. The panel is fixed so
  // the scrolling filter sidebar cannot clip it.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const open = pos != null
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const custom = useRef<HTMLInputElement>(null)
  const label = renameCompressor(name)
  const defaultName = defaultCompressorName(name)
  const overridden = shapeOverridden || colorOverridden || nameOverridden
  const swatches = [defaultColor.toLowerCase(), ...CHART_PALETTE.filter((c) => c !== defaultColor.toLowerCase())]
  const isCustomColor = !swatches.includes(color.toLowerCase())

  /** Panel position under (or, near the bottom, above) the marker; null when the marker is off screen. */
  const place = () => {
    const r = trigger.current?.getBoundingClientRect()
    if (!r || r.bottom < 0 || r.top > window.innerHeight) return null
    const below = r.bottom + 4 + PANEL_HEIGHT <= window.innerHeight
    return {
      top: below ? r.bottom + 4 : Math.max(4, r.top - 4 - PANEL_HEIGHT),
      left: Math.max(4, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 4)),
    }
  }

  useEffect(() => {
    if (!open) return
    // Focus the panel, not a shape: a focus ring on one shape next to the
    // selected one reads as two selections. Tab moves into the grid.
    panel.current?.focus()
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

  // The native colour input fires `input` continuously while dragging; save
  // only on `change` (when the system picker closes).
  useEffect(() => {
    const el = custom.current
    if (!el) return
    const onChange = () => pickColor(el.value)
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  })

  const saveName = (input: HTMLInputElement) => {
    const next = input.value.trim()
    const value = next === '' || next === defaultName ? null : next
    if (value === null) input.value = defaultName
    if (value !== (nameOverridden ? label : null)) onNameChange(value)
  }
  const pickShape = (s: string) => {
    if (s !== shape) onShapeChange(s === defaultShape ? null : s)
  }
  function pickColor(c: string) {
    const value = c.toLowerCase()
    if (value !== color.toLowerCase()) onColorChange(value === defaultColor.toLowerCase() ? null : value)
  }

  const cell = 'relative flex items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  const defaultMark = <span aria-hidden="true" className="absolute -bottom-1 h-0.5 w-3 rounded-full bg-foreground" />

  return (
    <div ref={root} className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        aria-label={`Marker style of ${label}: ${SHAPE_NAMES[shape] ?? shape}, ${color}${overridden ? ' (yours)' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Rename, or change marker shape and colour"
        onClick={() => setPos(open ? null : place())}
        className={`relative inline-flex h-6 w-6 items-center justify-center rounded-md border hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${open ? 'border-foreground' : 'border-transparent'}`}
      >
        <LegendMarker name={name} color={color} shape={shape} />
        {overridden && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-foreground" />}
      </button>
      {open && (
        <div
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label={`Name and marker style for ${label}`}
          style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
          className="fixed z-10 space-y-2.5 rounded-md border border-border bg-background p-2.5 outline-none"
        >
          <label className="block text-xs text-muted-foreground">
            Name
            <input
              // Remount when the saved name changes so the field shows it.
              key={label}
              type="text"
              defaultValue={label}
              placeholder={defaultName}
              maxLength={64}
              aria-label={`Display name for ${label}`}
              title={nameOverridden ? `Default: ${defaultName}` : undefined}
              onBlur={(e) => saveName(e.target)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(e.currentTarget) } }}
              className="mt-1 block h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <fieldset>
            <legend className="mb-1 text-xs text-muted-foreground">Shape</legend>
            <div className="grid grid-cols-5 gap-1.5">
              {CHART_SHAPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-label={`${SHAPE_NAMES[s]}${s === defaultShape ? ' (default)' : ''}`}
                  aria-pressed={s === shape}
                  title={`${SHAPE_NAMES[s]}${s === defaultShape ? ' (default)' : ''}`}
                  onClick={() => pickShape(s)}
                  className={`${cell} h-8 w-8 ${s === shape ? 'border-foreground bg-secondary' : 'border-border hover:bg-secondary'}`}
                >
                  <LegendMarker name={name} color={color} shape={s} size={16} />
                  {s === defaultShape && defaultMark}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-xs text-muted-foreground">Colour</legend>
            <div className="grid grid-cols-8 gap-1.5">
              {swatches.map((c) => {
                const selected = c === color.toLowerCase()
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={`${c}${c === swatches[0] ? ' (default)' : ''}`}
                    aria-pressed={selected}
                    title={`${c}${c === swatches[0] ? ' (default)' : ''}`}
                    onClick={() => pickColor(c)}
                    className={`${cell} h-5 w-5 ${selected ? 'border-foreground ring-1 ring-foreground ring-offset-1 ring-offset-background' : 'border-transparent'}`}
                    style={{ backgroundColor: c }}
                  >
                    {c === swatches[0] && defaultMark}
                  </button>
                )
              })}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                ref={custom}
                type="color"
                value={color.toLowerCase()}
                onChange={() => { /* saved on the native change event */ }}
                aria-label={`Custom colour for ${label}`}
                className={`h-6 w-8 cursor-pointer rounded border bg-transparent p-0 ${isCustomColor ? 'border-foreground' : 'border-border'}`}
              />
              <span className="font-mono text-muted-foreground">{isCustomColor ? color.toLowerCase() : 'Custom…'}</span>
            </label>
          </fieldset>

          <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
            <span>Underlined = default</span>
            {overridden && (
              <button type="button" className="text-foreground underline underline-offset-2" onClick={() => { setPos(null); onReset() }}>
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
