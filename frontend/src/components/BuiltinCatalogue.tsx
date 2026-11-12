import { useEffect, useMemo, useState } from 'react'
import CompressorSwatch from '@/components/CompressorSwatch'
import { apiFetch } from '@/lib/api'
import { getCompressorFamily, isBuiltinCompressor, renameCompressor } from '@/lib/compressors'
import type { CompressorOption, CompressorRegistry } from '@/types'

/** Options the native harness applies per entry; others are informational (spec §6.2). */
const NATIVE_OPTIONS = new Set(['level', 'max_bpc', 'lossy', 'max_precision', 'decimals', 'codec'])

function describeOption(opt: CompressorOption): string {
  if (opt.type === 'number') return `${opt.min ?? '?'}–${opt.max ?? '?'}, default ${String(opt.default)}`
  if (opt.type === 'boolean') return `on/off, default ${opt.default ? 'on' : 'off'}`
  return `${(opt.options ?? []).length} choices, default ${String(opt.default)}`
}

/** Read-only catalogue of the built-in algorithms and their options. */
export default function BuiltinCatalogue() {
  const [registry, setRegistry] = useState<CompressorRegistry | null>(null)
  useEffect(() => {
    apiFetch<CompressorRegistry>('/compressors').then((r) => setRegistry(r ?? {})).catch(() => setRegistry({}))
  }, [])

  const families = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const name of Object.keys(registry ?? {}).filter((n) => isBuiltinCompressor(n)).sort()) {
      const f = getCompressorFamily(name)
      map.set(f, [...(map.get(f) ?? []), name])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [registry])

  if (!registry) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <div className="space-y-5">
      {families.map(([family, names]) => (
        <section key={family} aria-label={family}>
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">{family}</h2>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <tbody>
                {names.map((name) => {
                  const options = Object.entries(registry[name] ?? {})
                  return (
                    <tr key={name} className="border-b border-border last:border-0 align-top">
                      <td className="p-2 w-56">
                        <span className="flex items-center gap-1.5 font-mono">
                          <CompressorSwatch name={name} />{renameCompressor(name)}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono">{name}</span>
                      </td>
                      <td className="p-2 text-xs">
                        {options.length === 0 ? (
                          <span className="text-muted-foreground">No configurable options</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {options.map(([key, opt]) => (
                              <li key={key}>
                                <span className="font-mono">{key}</span>: {describeOption(opt)}
                                {!NATIVE_OPTIONS.has(key) && <span className="text-muted-foreground"> (informational)</span>}
                                {key === 'codec' && opt.options && <span className="block text-muted-foreground truncate" title={opt.options.join(', ')}>{opt.options.join(', ')}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
