import { create } from 'zustand'
import { apiFetch } from '@/lib/api'
import { setDisplayNames, shapeKey } from '@/lib/compressors'

type StyleMap = Record<string, string>

interface ChartStylesState {
  /** The user's saved marker shape per compressor label (keyed by shapeKey). */
  shapes: StyleMap
  /** The user's saved colour (#rrggbb) per compressor label (keyed by shapeKey). */
  colors: StyleMap
  /** The user's display name per compressor label (keyed by shapeKey). */
  names: StyleMap
  error: string
  /** Local mode (shared read-only links): changes apply but are never saved. */
  local: boolean
  load: () => Promise<void>
  /** Starts local mode from the given styles (the share owner's). */
  useLocal: (styles: Partial<Record<'shapes' | 'colors' | 'names', StyleMap>>) => void
  /** Sets (or with `null` clears) one compressor's shape and saves it. */
  setShape: (name: string, shape: string | null) => Promise<void>
  /** Sets (or with `null` clears) one compressor's colour and saves it. */
  setColor: (name: string, color: string | null) => Promise<void>
  /** Renames (or with `null` restores the default name of) one compressor and saves it. */
  setName: (name: string, displayName: string | null) => Promise<void>
  /** Restores the shared default name, shape and colour of the given compressors and saves it. */
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
 * Per-user chart style overrides (marker shape, colour and display name), stored on the
 * server (`/me/chart-styles`). Changes apply immediately and are rolled back
 * if saving fails.
 */
export const useChartStyles = create<ChartStylesState>((set, get) => {
  const commit = async (shapes: StyleMap, colors: StyleMap, names: StyleMap = get().names) => {
    const previous = { shapes: get().shapes, colors: get().colors, names: get().names }
    set({ shapes, colors, names, error: '' })
    if (get().local) return
    try {
      const res = await apiFetch<Partial<Record<'shapes' | 'colors' | 'names', StyleMap>>>('/me/chart-styles', {
        method: 'PUT',
        body: JSON.stringify({ shapes, colors, names }),
      })
      set({ shapes: res?.shapes ?? shapes, colors: res?.colors ?? colors, names: res?.names ?? names })
    } catch (err) {
      set({ ...previous, error: err instanceof Error ? err.message : 'Failed to save the style' })
    }
  }
  return {
    shapes: {},
    colors: {},
    names: {},
    error: '',
    local: false,
    useLocal: (styles) => set({ shapes: styles.shapes ?? {}, colors: styles.colors ?? {}, names: styles.names ?? {}, error: '', local: true }),
    load: async () => {
      set({ local: false })
      try {
        const res = await apiFetch<Partial<Record<'shapes' | 'colors' | 'names', StyleMap>>>('/me/chart-styles')
        set({ shapes: res?.shapes ?? {}, colors: res?.colors ?? {}, names: res?.names ?? {}, error: '' })
      } catch {
        // Keep the defaults; the charts work without overrides.
      }
    },
    setShape: (name, shape) => commit(withEntry(get().shapes, name, shape), get().colors),
    setColor: (name, color) => commit(get().shapes, withEntry(get().colors, name, color)),
    setName: (name, displayName) => commit(get().shapes, get().colors, withEntry(get().names, name, displayName?.trim() || null)),
    reset: (labels) => {
      const shapes = { ...get().shapes }
      const colors = { ...get().colors }
      const names = { ...get().names }
      for (const n of labels) {
        delete shapes[shapeKey(n)]
        delete colors[shapeKey(n)]
        delete names[shapeKey(n)]
      }
      return commit(shapes, colors, names)
    },
    clear: () => set({ shapes: {}, colors: {}, names: {}, error: '', local: false }),
  }
})

// renameCompressor reads the names synchronously, so mirror them there.
useChartStyles.subscribe((s, prev) => { if (s.names !== prev.names) setDisplayNames(s.names) })
