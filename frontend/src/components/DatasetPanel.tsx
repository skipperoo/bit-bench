import { useMemo, useState } from 'react'
import { AlertTriangle, Database, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  CHUNK_PRESETS,
  chunkSizeHint,
  TRANSFORM_INFO,
  WHOLE_SERIES,
  describeChunking,
  formatCount,
  planRuns,
} from '@/lib/datasets'
import type { DatasetListResponse, DatasetSelection, Transform } from '@/lib/datasets'

interface DatasetPanelProps {
  catalog: DatasetListResponse | null
  selection: DatasetSelection
  onChange: (next: DatasetSelection) => void
  disabled?: boolean
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

const chipClass = (active: boolean) => [
  'px-2.5 py-1 rounded-md border text-xs font-mono transition-colors',
  active ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/60',
].join(' ')

export default function DatasetPanel({ catalog, selection, onChange, disabled }: DatasetPanelProps) {
  const [customSize, setCustomSize] = useState('')
  const datasets = catalog?.datasets ?? []
  const current = datasets.find((d) => d.name === selection.dataset)
  const selectedSeries = useMemo(
    () => (current?.series ?? []).filter((s) => selection.series.includes(s.name)),
    [current, selection.series],
  )
  const runs = useMemo(
    () => planRuns(selectedSeries, selection.chunkSizes, selection.maxChunks, selection.transforms),
    [selectedSeries, selection.chunkSizes, selection.maxChunks, selection.transforms],
  )
  const set = (patch: Partial<DatasetSelection>) => onChange({ ...selection, ...patch })
  // Series shorter than a selected chunk size, with those sizes (transform-independent).
  const extended = useMemo(() => {
    const bySeries = new Map<string, number[]>()
    for (const r of runs.filter((r) => r.transform === runs[0]?.transform)) {
      for (const s of r.extended) bySeries.set(s, [...(bySeries.get(s) ?? []), r.chunkSize])
    }
    return [...bySeries]
  }, [runs])

  if (catalog && datasets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground space-y-2">
        <p className="flex items-center gap-2 text-foreground font-medium"><Database className="w-4 h-4" /> No standardized datasets yet</p>
        <p>
          Place full recordings in <code>./datasets/&lt;dataset&gt;/&lt;series&gt;.bin</code> on the server
          (mounted at <code>/data/datasets</code>). Try{' '}
          <code>python3 scripts/datasets/make_synthetic.py</code> or see <code>docs/datasets.md</code>.
        </p>
      </div>
    )
  }

  const usable = (current?.series ?? []).filter((s) => !s.error)
  const addCustom = () => {
    const n = Math.floor(Number(customSize))
    if (Number.isFinite(n) && n >= 2) {
      set({ chunkSizes: [...new Set([...selection.chunkSizes, n])] })
      setCustomSize('')
    }
  }

  return (
    <fieldset disabled={disabled} className="space-y-5">
      <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="dataset-select">Dataset</Label>
          <select
            id="dataset-select"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            value={selection.dataset}
            // Series start unchecked: the user picks what to benchmark.
            onChange={(e) => set({ dataset: e.target.value, series: [] })}
          >
            <option value="">{catalog ? 'Choose…' : 'Loading…'}</option>
            {datasets.map((d) => (
              <option key={d.name} value={d.name}>{d.name} ({d.series.length})</option>
            ))}
          </select>
        </div>
        {current && (current.description || current.source) && (
          <div className="text-xs text-muted-foreground self-end">
            {current.description && <p>{current.description}</p>}
            {current.source && <p className="italic">{current.source}</p>}
          </div>
        )}
      </div>

      {current && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Series ({selection.series.length}/{usable.length})</Label>
            <div className="flex gap-3 text-xs">
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => set({ series: usable.map((s) => s.name) })}>All</button>
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => set({ series: [] })}>None</button>
            </div>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-48 overflow-y-auto rounded-md border border-border p-2">
            {current.series.map((s) => (
              <label
                key={s.name}
                title={s.error || `${s.values.toLocaleString()} values · decimals ${s.decimals}`}
                className={`flex items-center gap-2 text-sm px-1.5 py-1 rounded ${s.error ? 'opacity-50' : 'hover:bg-secondary/50 cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  disabled={Boolean(s.error)}
                  checked={selection.series.includes(s.name)}
                  onChange={() => set({ series: toggle(selection.series, s.name) })}
                />
                <span className="font-mono truncate">{s.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{s.error ? 'invalid' : formatCount(s.values)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>Chunk size (samples)</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={chipClass(selection.chunkSizes.includes(WHOLE_SERIES))}
            onClick={() => set({ chunkSizes: toggle(selection.chunkSizes, WHOLE_SERIES) })}
            title="Compress each series as a single input"
          >
            whole series
          </button>
          {CHUNK_PRESETS.map((p) => (
            <button
              key={p.samples}
              type="button"
              className={chipClass(selection.chunkSizes.includes(p.samples))}
              onClick={() => set({ chunkSizes: toggle(selection.chunkSizes, p.samples) })}
              title={chunkSizeHint(p.samples)}
            >
              {p.samples.toLocaleString()}
            </button>
          ))}
          {selection.chunkSizes
            .filter((n) => n !== WHOLE_SERIES && !CHUNK_PRESETS.some((p) => p.samples === n))
            .map((n) => (
              <button key={n} type="button" className={chipClass(true)} onClick={() => set({ chunkSizes: toggle(selection.chunkSizes, n) })}>
                {n.toLocaleString()} ×
              </button>
            ))}
          <div className="flex items-center gap-1">
            <Input
              aria-label="Custom chunk size"
              type="number"
              min={2}
              placeholder="custom"
              className="h-7 w-24 text-xs"
              value={customSize}
              onChange={(e) => setCustomSize(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
            />
            <button type="button" aria-label="Add chunk size" onClick={addCustom} className="p-1 rounded hover:bg-secondary text-muted-foreground">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Sizes count samples, not bytes; hover a size for its size in KB as 8-, 16-, 32- and 64-bit integers. Each size becomes its own benchmark.</p>
        {extended.length > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <p className="font-medium">
                {extended.length === 1 ? '1 series is' : `${extended.length} series are`} shorter than the chunk size and will be repeated to fill one chunk
              </p>
              <ul className="mt-1 space-y-0.5">
                {extended.slice(0, 6).map(([name, sizes]) => (
                  <li key={name}>
                    <span className="font-mono">{name}</span> ({formatCount(current?.series.find((s) => s.name === name)?.values ?? 0)} values) at {sizes.map((n) => n.toLocaleString()).join(', ')} samples
                  </li>
                ))}
                {extended.length > 6 && <li>… {extended.length - 6} more</li>}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="max-chunks">Max chunks per series</Label>
          <Input
            id="max-chunks"
            type="number"
            min={0}
            max={catalog?.max_chunks_per_series ?? 10000}
            className="h-8 w-28"
            value={selection.maxChunks}
            onChange={(e) => set({ maxChunks: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
          <p className="text-xs text-muted-foreground">Evenly spaced over the recording; 0 = every chunk.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Transform</Label>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TRANSFORM_INFO) as Transform[]).map((t) => (
              <button
                key={t}
                type="button"
                className={chipClass(selection.transforms.includes(t))}
                onClick={() => set({ transforms: toggle(selection.transforms, t) })}
                title={TRANSFORM_INFO[t].help}
              >
                {TRANSFORM_INFO[t].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Each transform becomes its own benchmark.</p>
        </div>
      </div>

      {current && selectedSeries.length > 0 && runs.length > 0 && (
        <div data-testid="dataset-plan" className="rounded-md bg-secondary/30 p-3 text-xs space-y-1">
          <p className="font-medium text-foreground">
            Creates {runs.length} benchmark{runs.length === 1 ? '' : 's'} over {selectedSeries.length} series
          </p>
          <ul className="space-y-0.5 text-muted-foreground font-mono">
            {runs.slice(0, 8).map((r) => (
              <li key={`${r.transform}-${r.chunkSize}`}>
                {r.transform} · {describeChunking(r.chunkSize, selection.maxChunks)} → {r.inputs} input{r.inputs === 1 ? '' : 's'}
                {r.extended.length > 0 && <span className="text-amber-700 dark:text-amber-400"> (repeats {r.extended.length} short series)</span>}
              </li>
            ))}
            {runs.length > 8 && <li>… {runs.length - 8} more</li>}
          </ul>
        </div>
      )}
    </fieldset>
  )
}
