import { useId, useMemo } from 'react'
import { LegendMarker } from '@/components/charts/CompressorMarker'
import StylePicker from '@/components/StylePicker'
import { LABEL_SEPARATOR, getCompressorFamily, shortCompressorNames } from '@/lib/compressors'
import type { CompressorStyle } from '@/lib/compressors'

/** Per-user marker styles: with it, every marker becomes a shape/colour picker. */
export interface StyleEditing {
  /** Style each compressor gets without the user's overrides. */
  defaults: Map<string, CompressorStyle>
  overridden: (name: string) => { shape: boolean; color: boolean; name: boolean }
  /** `null` restores the default name. */
  onNameChange: (name: string, displayName: string | null) => void
  onShapeChange: (name: string, shape: string | null) => void
  onColorChange: (name: string, color: string | null) => void
  /** Restores the default name, shape and colour of the given compressors. */
  onReset: (names: string[]) => void
  /** Why the last change could not be saved. */
  error?: string
}

/**
 * Checklist of the compressors/instances of a result set, grouped by family.
 * Hidden instances are removed from every chart and table of the view.
 */
export default function InstanceFilter({ names, colors, shapes, hidden, onChange, styleEditing }: {
  names: string[]
  colors: Map<string, string>
  shapes?: Map<string, string>
  hidden: Set<string>
  onChange: (hidden: Set<string>) => void
  styleEditing?: StyleEditing
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
  const short = shortCompressorNames(names)
  const shown = names.length - names.filter((n) => hidden.has(n)).length
  const customised = styleEditing ? names.filter((n) => { const o = styleEditing.overridden(n); return o.shape || o.color || o.name }) : []

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
          // min-w-0: a fieldset otherwise never shrinks below its widest name.
          <fieldset key={family} className="min-w-0 space-y-1">
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
                  {styleEditing && shape ? (
                    <StylePicker
                      name={m}
                      color={color}
                      shape={shape}
                      defaultColor={styleEditing.defaults.get(m)?.color ?? color}
                      defaultShape={styleEditing.defaults.get(m)?.shape ?? shape}
                      shapeOverridden={styleEditing.overridden(m).shape}
                      colorOverridden={styleEditing.overridden(m).color}
                      nameOverridden={styleEditing.overridden(m).name}
                      onNameChange={(n) => styleEditing.onNameChange(m, n)}
                      onShapeChange={(s) => styleEditing.onShapeChange(m, s)}
                      onColorChange={(c) => styleEditing.onColorChange(m, c)}
                      onReset={() => styleEditing.onReset([m])}
                    />
                  ) : (
                    <LegendMarker name={m} color={color} shape={shape} />
                  )}
                  <label htmlFor={id} className="flex min-w-0 cursor-pointer font-mono text-xs" title={short.get(m)!.full}>
                    <span className="min-w-[3ch] truncate">{short.get(m)!.base}</span>
                    {short.get(m)!.options && <span className="max-w-[75%] shrink-0 truncate text-muted-foreground">{LABEL_SEPARATOR}{short.get(m)!.options}</span>}
                  </label>
                </div>
              )
            })}
          </fieldset>
        )
      })}
      {styleEditing && (
        <p className="text-xs text-muted-foreground">
          Click a marker to rename the compressor or change its shape or colour; your choice is saved to your account.
          {customised.length > 0 && (
            <>
              {' '}
              <button type="button" className="text-foreground underline underline-offset-2" onClick={() => styleEditing.onReset(customised)}>
                Reset {customised.length === 1 ? '1 style' : `${customised.length} styles`}
              </button>
            </>
          )}
          {styleEditing.error && <span role="alert" className="block text-destructive">Style not saved: {styleEditing.error}</span>}
        </p>
      )}
    </div>
  )
}
