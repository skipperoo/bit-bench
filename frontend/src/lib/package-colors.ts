import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { packageColor, registerCompressorColors } from '@/lib/compressors'
import type { CompressorPackage } from '@/types'

let loading: Promise<void> | null = null

/**
 * Loads the spec.yaml colours of the visible packages once per session and
 * registers them with the colour helpers.
 */
export function loadPackageColors(): Promise<void> {
  if (!loading) {
    loading = apiFetch<CompressorPackage[]>('/compressors/packages')
      .then((packages) => {
        if (!Array.isArray(packages)) return
        registerCompressorColors(Object.fromEntries(packages.map((p) => [p.name, packageColor(p.spec)])))
      })
      .catch(() => { loading = null })
  }
  return loading
}

/** Re-renders the caller once package colours are known (skipped when disabled, e.g. logged out). */
export function usePackageColors(enabled = true): void {
  const [, setReady] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    loadPackageColors().then(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [enabled])
}
