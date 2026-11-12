import { useMemo } from 'react'
import { LegendMarker } from '@/components/charts/CompressorMarker'
import { getCompressorFamily, renameCompressor } from '@/lib/compressors'

/**
 * Checklist of the compressors/instances of a result set, grouped by family.
 * Hidden instances are removed from every chart and table of the view.
 */
export default function InstanceFilter({ names, colors, shapes, hidden, onChange }: {
  names: string[]
  colors: Map<string, string>
  shapes?: Map<string, string>
  hidden: Set<string>
  onChange: (hidden: Set<string>) => void
}) {
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
            {members.map((m) => (
              <label key={m} className="flex items-center gap-2 pl-5 cursor-pointer">
                <input type="checkbox" checked={!hidden.has(m)} onChange={(e) => set([m], e.target.checked)} />
                <LegendMarker name={m} color={colors.get(m) ?? '#64748b'} shape={shapes?.get(m)} />
                <span className="font-mono text-xs truncate" title={renameCompressor(m)}>{renameCompressor(m)}</span>
              </label>
            ))}
          </fieldset>
        )
      })}
    </div>
  )
}
