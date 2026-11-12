import { create } from 'zustand'
import { apiFetch } from '@/lib/api'
import { shapeKey } from '@/lib/compressors'

interface ChartShapesState {
  /** The user's saved shape per compressor label (keyed by shapeKey). */
  overrides: Record<string, string>
  error: string
  load: () => Promise<void>
  /** Sets (or with `null` clears) one compressor's shape and saves it. */
  setShape: (name: string, shape: string | null) => Promise<void>
  /** Restores the shared default shape of the given compressors and saves it. */
  reset: (names: string[]) => Promise<void>
  clear: () => void
}

async function save(overrides: Record<string, string>): Promise<Record<string, string>> {
  const res = await apiFetch<{ shapes: Record<string, string> }>('/me/chart-shapes', {
    method: 'PUT',
    body: JSON.stringify({ shapes: overrides }),
  })
  return res?.shapes ?? overrides
}

/**
 * Per-user marker shape overrides, stored on the server (`/me/chart-shapes`).
 * Changes are applied immediately and rolled back if saving fails.
 */
export const useChartShapes = create<ChartShapesState>((set, get) => {
  const commit = async (next: Record<string, string>) => {
    const previous = get().overrides
    set({ overrides: next, error: '' })
    try {
      set({ overrides: await save(next) })
    } catch (err) {
      set({ overrides: previous, error: err instanceof Error ? err.message : 'Failed to save the shape' })
    }
  }
  return {
    overrides: {},
    error: '',
    load: async () => {
      try {
        const res = await apiFetch<{ shapes?: Record<string, string> }>('/me/chart-shapes')
        set({ overrides: res?.shapes ?? {}, error: '' })
      } catch {
        // Keep the defaults; the charts work without overrides.
      }
    },
    setShape: (name, shape) => {
      const next = { ...get().overrides }
      if (shape) next[shapeKey(name)] = shape
      else delete next[shapeKey(name)]
      return commit(next)
    },
    reset: (names) => {
      const next = { ...get().overrides }
      for (const n of names) delete next[shapeKey(n)]
      return commit(next)
    },
    clear: () => set({ overrides: {}, error: '' }),
  }
})
