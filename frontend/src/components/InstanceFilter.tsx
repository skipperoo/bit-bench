import { useId, useMemo } from 'react'
import { LegendMarker } from '@/components/charts/CompressorMarker'
import ShapePicker from '@/components/ShapePicker'
import { getCompressorFamily, renameCompressor } from '@/lib/compressors'

/** Per-user marker shapes: with it, every marker becomes a shape picker. */
export interface ShapeEditing {
  /** Shape each compressor gets without the user's overrides. */
  defaults: Map<string, string>
  overridden: (name: string) => boolean
  onChange: (name: string, shape: string | null) => void
  /** Restores the default shape of the given compressors. */
  onReset: (names: string[]) => void
  /** Why the last change could not be saved. */
  error?: string
}

/**
 * Checklist of the compressors/instances of a result set, grouped by family.
 * Hidden instances are removed from every chart and table of the view.
 */
export default function InstanceFilter({ names, colors, shapes, hidden, onChange, shapeEditing }: {
  names: string[]
  colors: Map<string, string>
  shapes?: Map<string, string>
  hidden: Set<string>
  onChange: (hidden: Set<string>) => void
  shapeEditing?: ShapeEditing
}) {
  const idBase = useId()
  const families = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const n of names) {
      const f = getCompressorFamily(n)
      map.set(f, [...(map.get(f) ?? []), n])
    }
    return [...map.entries()].sort(([a], [b]) => (a === 'Custom' ? -1 : b === 'Custom' ? 1 : a.localeCompare(b)))
  }, [names])

  const set = (members: string[], visible: boolean) => {
    const next = new Set(hidden)
    for (const m of members) {
      if (visible) next.delete(m)
      else next.add(m)
    }
    onChange(next)
  }
  const shown = names.length - names.filter((n) => hidden.has(n)).length
  const customised = shapeEditing ? names.filter((n) => shapeEditing.overridden(n)) : []

  return (
    <div className="space-y-3 text-sm" aria-label="Compressor filter">
      <div className="flex items-center justify-between">
        <span className="font-medium">Compressors <span className="text-muted-foreground font-normal">{shown}/{names.length}</span></span>
        <span className="flex gap-2 text-xs">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange(new Set())}>All</button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange(new Set(names))}>None</button>
        </span>
      </div>
      {families.map(([family, members]) => {
        const visibleCount = members.filter((m) => !hidden.has(m)).length
        return (
          <fieldset key={family} className="space-y-1">
            <legend className="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground">
              <input
                type="checkbox"
                aria-label={`Show family ${family}`}
                checked={visibleCount === members.length}
                ref={(el) => { if (el) el.indeterminate = visibleCount > 0 && visibleCount < members.length }}
                onChange={(e) => set(members, e.target.checked)}
              />
              {family}
            </legend>
            {members.map((m) => {
              const id = `${idBase}-${names.indexOf(m)}`
              const color = colors.get(m) ?? '#64748b'
              const shape = shapes?.get(m)
              return (
                <div key={m} className="flex items-center gap-1.5 pl-5">
                  <input id={id} type="checkbox" checked={!hidden.has(m)} onChange={(e) => set([m], e.target.checked)} />
                  {shapeEditing && shape ? (
                    <ShapePicker
                      name={m}
                      color={color}
                      shape={shape}
                      defaultShape={shapeEditing.defaults.get(m) ?? shape}
                      overridden={shapeEditing.overridden(m)}
                      onChange={(s) => shapeEditing.onChange(m, s)}
                    />
                  ) : (
                    <LegendMarker name={m} color={color} shape={shape} />
                  )}
                  <label htmlFor={id} className="min-w-0 cursor-pointer truncate font-mono text-xs" title={renameCompressor(m)}>{renameCompressor(m)}</label>
                </div>
              )
            })}
          </fieldset>
        )
      })}
      {shapeEditing && (
        <p className="text-xs text-muted-foreground">
          Click a marker to change its shape; your choice is saved to your account.
          {customised.length > 0 && (
            <>
              {' '}
              <button type="button" className="text-foreground underline underline-offset-2" onClick={() => shapeEditing.onReset(customised)}>
                Reset {customised.length === 1 ? '1 shape' : `${customised.length} shapes`}
              </button>
            </>
          )}
          {shapeEditing.error && <span role="alert" className="block text-destructive">Shape not saved: {shapeEditing.error}</span>}
        </p>
      )}
    </div>
  )
}
