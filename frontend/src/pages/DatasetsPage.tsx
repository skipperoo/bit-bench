import { useIsPhone } from '@/lib/responsive'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { CHUNK_PRESETS, chunkCount, formatCount } from '@/lib/datasets'
import type { DatasetListResponse, StandardDataset } from '@/lib/datasets'
import { formatBytes } from '@/lib/format'

interface Preview {
  values: number
  decimals: number
  min: number
  max: number
  mean: number
  head: number
  sparkline: [number, number][]
}

/** Min/max band of the first values of a series. */
function Sparkline({ points, width = 200, height = 32 }: { points: [number, number][]; width?: number; height?: number }) {
  if (points.length === 0) return null
  const lo = Math.min(...points.map((p) => p[0]))
  const hi = Math.max(...points.map((p) => p[1]))
  const span = hi - lo || 1
  const x = (i: number) => (points.length === 1 ? width / 2 : (i / (points.length - 1)) * width)
  const y = (v: number) => height - 1 - ((v - lo) / span) * (height - 2)
  const top = points.map((p, i) => `${x(i)},${y(p[1])}`)
  const bottom = points.map((p, i) => `${x(i)},${y(p[0])}`).reverse()
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Sparkline of the first values" className="text-foreground">
      <polygon points={[...top, ...bottom].join(' ')} fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth={0.75} />
    </svg>
  )
}

function scaled(v: number, decimals: number): string {
  return decimals > 0 ? (v / 10 ** decimals).toFixed(decimals) : String(v)
}

function DatasetCard({ dataset }: { dataset: StandardDataset }) {
  const navigate = useNavigate()
  const phone = useIsPhone()
  const [previews, setPreviews] = useState<Record<string, Preview | 'error'>>({})

  useEffect(() => {
    let alive = true
    for (const s of dataset.series) {
      if (s.error) continue
      apiFetch<Preview>(`/datasets/${encodeURIComponent(dataset.name)}/series/${encodeURIComponent(s.name)}/preview`)
        .then((p) => { if (alive && p) setPreviews((prev) => ({ ...prev, [s.name]: p })) })
        .catch(() => { if (alive) setPreviews((prev) => ({ ...prev, [s.name]: 'error' })) })
    }
    return () => { alive = false }
  }, [dataset])

  const usable = dataset.series.filter((s) => !s.error)
  const totalValues = usable.reduce((a, s) => a + s.values, 0)
  const sizes = CHUNK_PRESETS.filter((p) => usable.some((s) => s.values >= p.samples))

  return (
    <section aria-label={`Dataset ${dataset.name}`} className="rounded-md border border-border">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="text-lg font-medium font-mono">{dataset.name}</h2>
          {dataset.description && <p className="text-sm">{dataset.description}</p>}
          {dataset.source && <p className="text-xs text-muted-foreground italic">{dataset.source}</p>}
          <p className="text-xs text-muted-foreground mt-1">
            {usable.length} series · {formatCount(totalValues)} values
            {usable.length < dataset.series.length && ` · ${dataset.series.length - usable.length} invalid`}
          </p>
        </div>
        <Button size="sm" className="max-md:w-full" disabled={usable.length === 0} onClick={() => navigate('/new', { state: { dataset: dataset.name } })}>
          <Play className="w-4 h-4 mr-1" />Benchmark this dataset
        </Button>
      </header>
      {phone ? (
        <ul className="divide-y divide-border">
          {dataset.series.map((s) => {
            const p = previews[s.name]
            return (
              <li key={s.name} className="space-y-1 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-sm">{s.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.error ? formatBytes(s.size_bytes) : `${s.values.toLocaleString()} · ${formatBytes(s.size_bytes)}`}</span>
                </div>
                {s.error ? <p className="text-xs text-destructive">{s.error}</p> : (
                  <>
                    {p && p !== 'error' && <div className="text-foreground [&_svg]:h-8 [&_svg]:w-full"><Sparkline points={p.sparkline} /></div>}
                    <p className="font-mono text-xs text-muted-foreground">
                      {p && p !== 'error' ? `${scaled(p.min, p.decimals)} … ${scaled(p.max, p.decimals)}` : p === 'error' ? '–' : '…'}
                      {s.decimals > 0 && ` · decimals ${s.decimals}`}
                    </p>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left text-xs">
              <th className="p-2 font-medium">Series</th>
              <th className="p-2 font-medium text-right">Values</th>
              <th className="p-2 font-medium text-right">Range</th>
              <th className="p-2 font-medium">First 10k values</th>
              <th className="p-2 font-medium" title="Full chunks per preset chunk size (samples)">Chunks per size</th>
            </tr>
          </thead>
          <tbody>
            {dataset.series.map((s) => {
              const p = previews[s.name]
              return (
                <tr key={s.name} className="border-b border-border last:border-0 align-middle">
                  <td className="p-2 font-mono">
                    {s.name}
                    <span className="block text-xs text-muted-foreground font-sans">{formatBytes(s.size_bytes)}{s.decimals > 0 ? ` · decimals ${s.decimals}` : ''}</span>
                  </td>
                  {s.error ? (
                    <td colSpan={4} className="p-2 text-xs text-destructive">{s.error}</td>
                  ) : (
                    <>
                      <td className="p-2 text-right tabular-nums">{s.values.toLocaleString()}</td>
                      <td className="p-2 text-right tabular-nums font-mono text-xs">
                        {p && p !== 'error' ? `${scaled(p.min, p.decimals)} … ${scaled(p.max, p.decimals)}` : p === 'error' ? '–' : '…'}
                      </td>
                      <td className="p-2">{p && p !== 'error' ? <Sparkline points={p.sparkline} /> : null}</td>
                      <td className="p-2 text-xs font-mono text-muted-foreground">
                        {sizes.map((preset) => `${preset.samples}→${chunkCount(s.values, preset.samples)}`).join('  ')}
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}
    </section>
  )
}

export default function DatasetsPage() {
  const [catalog, setCatalog] = useState<StandardDataset[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch<Partial<DatasetListResponse>>('/datasets')
      .then((d) => setCatalog(Array.isArray(d?.datasets) ? d.datasets : []))
      .catch((err) => { setError(err instanceof Error ? err.message : 'Failed to load datasets'); setCatalog([]) })
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Datasets</h1>
        <p className="text-sm text-muted-foreground">Standardized recordings stored on the server (<code>./datasets/&lt;dataset&gt;/&lt;series&gt;.bin</code>), cut into chunks per experiment.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {catalog === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : catalog.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground space-y-2">
          <p className="flex items-center gap-2 text-foreground font-medium"><Database className="w-4 h-4" />No standardized datasets yet</p>
          <p>
            Place full recordings in <code>./datasets/&lt;dataset&gt;/&lt;series&gt;.bin</code> next to <code>docker-compose.yml</code>.
            Create sample data with <code>python3 scripts/datasets/make_synthetic.py</code>, convert your own CSV/NumPy data with
            {' '}<code>scripts/datasets/make_dataset.py</code>; see <code>docs/datasets.md</code>.
          </p>
        </div>
      ) : (
        catalog.map((d) => <DatasetCard key={d.name} dataset={d} />)
      )}
    </div>
  )
}
