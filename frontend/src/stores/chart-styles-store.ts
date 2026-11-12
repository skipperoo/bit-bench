import { create } from 'zustand'
import { apiFetch } from '@/lib/api'
import { shapeKey } from '@/lib/compressors'

type StyleMap = Record<string, string>

interface ChartStylesState {
  /** The user's saved marker shape per compressor label (keyed by shapeKey). */
  shapes: StyleMap
  /** The user's saved colour (#rrggbb) per compressor label (keyed by shapeKey). */
  colors: StyleMap
  error: string
  load: () => Promise<void>
  /** Sets (or with `null` clears) one compressor's shape and saves it. */
  setShape: (name: string, shape: string | null) => Promise<void>
  /** Sets (or with `null` clears) one compressor's colour and saves it. */
  setColor: (name: string, color: string | null) => Promise<void>
  /** Restores the shared default shape and colour of the given compressors and saves it. */
  reset: (names: string[]) => Promise<void>
  clear: () => void
}

function withEntry(map: StyleMap, name: string, value: string | null): StyleMap {
  const next = { ...map }
  if (value) next[shapeKey(name)] = value
  else delete next[shapeKey(name)]
  return next
}

/**
 * Per-user chart style overrides (marker shape and colour), stored on the
 * server (`/me/chart-styles`). Changes apply immediately and are rolled back
 * if saving fails.
 */
export const useChartStyles = create<ChartStylesState>((set, get) => {
  const commit = async (shapes: StyleMap, colors: StyleMap) => {
    const previous = { shapes: get().shapes, colors: get().colors }
    set({ shapes, colors, error: '' })
    try {
      const res = await apiFetch<{ shapes?: StyleMap; colors?: StyleMap }>('/me/chart-styles', {
        method: 'PUT',
        body: JSON.stringify({ shapes, colors }),
      })
      set({ shapes: res?.shapes ?? shapes, colors: res?.colors ?? colors })
    } catch (err) {
      set({ ...previous, error: err instanceof Error ? err.message : 'Failed to save the style' })
    }
  }
  return {
    shapes: {},
    colors: {},
    error: '',
    load: async () => {
      try {
        const res = await apiFetch<{ shapes?: StyleMap; colors?: StyleMap }>('/me/chart-styles')
        set({ shapes: res?.shapes ?? {}, colors: res?.colors ?? {}, error: '' })
      } catch {
        // Keep the defaults; the charts work without overrides.
      }
    },
    setShape: (name, shape) => commit(withEntry(get().shapes, name, shape), get().colors),
    setColor: (name, color) => commit(get().shapes, withEntry(get().colors, name, color)),
    reset: (names) => {
      const shapes = { ...get().shapes }
      const colors = { ...get().colors }
      for (const n of names) {
        delete shapes[shapeKey(n)]
        delete colors[shapeKey(n)]
      }
      return commit(shapes, colors)
    },
    clear: () => set({ shapes: {}, colors: {}, error: '' }),
  }
})
