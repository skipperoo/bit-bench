import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Loader2, FileUp, AlertCircle, CheckCircle2, X, Plus, Trash2, Search } from 'lucide-react'
import { apiFetch, apiUpload } from '@/lib/api'
import { shouldUseSlider } from '@/lib/options'
import { renameCompressor } from '@/lib/compressors'
import {
  MAX_INSTANCES_PER_BENCHMARK,
  buildLabel,
  canonicalOptions,
  defaultOptions,
  hasVariableOptions,
  validateInstances,
} from '@/lib/instances'
import type { InstanceDraft } from '@/lib/instances'
import type { CompressorRegistry, CompressorOption, CompressorInstance } from '@/types'

interface CompressorFamily {
  name: string
  compressors: string[]
}

const FAMILIES: CompressorFamily[] = [
  {
    name: 'Time Series',
    compressors: ['gorilla', 'chimp', 'chimp128', 'tsxor', 'elf', 'alp', 'neats', 'camel', 'falcon'],
  },
  {
    name: 'GEF',
    compressors: [
      'rle_gef', 'u_gef_approximate', 'u_gef_optimal',
      'b_gef_approximate', 'b_gef_optimal',
      'b_star_gef_approximate', 'b_star_gef_optimal',
    ],
  },
  {
    name: 'Block-sorting',
    compressors: ['bzip2', 'bzip3'],
  },
  {
    name: 'Dictionary-based',
    compressors: ['brotli', 'gzip', 'lz4', 'snappy', 'xz', 'zstd'],
  },
  {
    name: 'Others',
    compressors: ['dac', 'pfordelta'],
  },
]

export default function UploadPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [multiMode, setMultiMode] = useState<'average' | 'sequential'>('average')
  const [compressors, setCompressors] = useState<CompressorRegistry>({})
  const [instances, setInstances] = useState<InstanceDraft[]>([])
  const [expandedInstance, setExpandedInstance] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const restoredRef = useRef(false)

  const loadCompressors = useCallback(async () => {
    try {
      const reg = await apiFetch<CompressorRegistry>('/compressors')
      setCompressors(reg)
    } catch {
      // compressors will be loaded on demand
    }
  }, [])

  useEffect(() => { loadCompressors() }, [loadCompressors])

  // Restore the last used configuration once the registry is available.
  useEffect(() => {
    if (restoredRef.current || Object.keys(compressors).length === 0) return
    restoredRef.current = true
    apiFetch<{ last_bench_config?: { compressors?: unknown } }>('/me')
      .then((u) => {
        const saved = u.last_bench_config?.compressors
        if (!saved) return
        const drafts: InstanceDraft[] = []
        if (Array.isArray(saved)) {
          for (const item of saved as CompressorInstance[]) {
            if (!item || typeof item.name !== 'string') continue
            const schema = compressors[item.name]
            if (!schema) continue
            drafts.push({ name: item.name, options: canonicalOptions(schema, item.options || {}) })
          }
        } else if (typeof saved === 'object') {
          for (const [compName, opts] of Object.entries(saved as Record<string, Record<string, unknown>>)) {
            const schema = compressors[compName]
            if (!schema) continue
            drafts.push({ name: compName, options: canonicalOptions(schema, opts || {}) })
          }
        }
        if (drafts.length > 0) {
          setInstances(drafts.slice(0, MAX_INSTANCES_PER_BENCHMARK))
        }
      })
      .catch(() => {})
  }, [compressors])

  const customNames = useMemo(() => {
    const builtin = new Set(FAMILIES.flatMap((f) => f.compressors))
    return new Set(Object.keys(compressors).filter((c) => !builtin.has(c)))
  }, [compressors])

  const validationError = useMemo(
    () => validateInstances(instances, compressors, customNames),
    [instances, compressors, customNames]
  )

  const addInstance = useCallback((compName: string) => {
    const schema = compressors[compName] || {}
    const options = defaultOptions(schema)
    setInstances((prev) => {
      if (prev.length >= MAX_INSTANCES_PER_BENCHMARK) return prev
      const next = [...prev, { name: compName, options }]
      setExpandedInstance(next.length - 1)
      return next
    })
    setError('')
  }, [compressors])

  const removeInstance = useCallback((index: number) => {
    setInstances((prev) => prev.filter((_, i) => i !== index))
    setExpandedInstance((current) => (current === index ? null : current !== null && current > index ? current - 1 : current))
  }, [])

  const updateInstanceOption = useCallback((index: number, key: string, value: unknown) => {
    setInstances((prev) => prev.map((inst, i) =>
      i === index ? { ...inst, options: { ...inst.options, [key]: value } } : inst
    ))
  }, [])

  const handleFileChange = useCallback((newFiles: File[]) => {
    setFiles(newFiles)
    if (newFiles.length === 0) return
    // Autocomplete benchmark name from first filename (without extension)
    if (!name) {
      const base = newFiles[0].name.replace(/\.[^.]+$/, '')
      setName(base)
    }
    setError('')
  }, [name])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const newFiles = Array.from(e.dataTransfer.files)
    if (newFiles.length > 0) handleFileChange(newFiles)
  }, [handleFileChange])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files || [])
    if (newFiles.length > 0) handleFileChange(newFiles)
  }, [handleFileChange])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || files.length === 0 || validationError) return
    setLoading(true)
    setError('')
    try {
      const compressorsPayload = instances.map((inst) => ({ name: inst.name, options: inst.options }))

      // Save config for next time
      apiFetch('/me/config', {
        method: 'PUT',
        body: JSON.stringify({ compressors: compressorsPayload }),
      }).catch(() => {})

      if (files.length === 1 || multiMode === 'average') {
        // One benchmark; all files are processed in parallel and averaged.
        const formData = new FormData()
        formData.append('name', multiMode === 'average' && files.length > 1
          ? `${name} (avg ${files.length})` : name)
        for (const f of files) {
          formData.append('files', f)
        }
        formData.append('compressors', JSON.stringify(compressorsPayload))
        await apiUpload<{ id: string }>('/benchmarks', formData)
        navigate(`/results`)
      } else {
        // Sequential mode: enqueue each file as a separate benchmark
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const fname = f.name.replace(/\.[^.]+$/, '')
          const formData = new FormData()
          formData.append('name', `${name} (${fname})`)
          formData.append('files', f)
          formData.append('compressors', JSON.stringify(compressorsPayload))
          await apiUpload<{ id: string }>('/benchmarks', formData)
          if (i === files.length - 1) {
            navigate(`/results`)
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  const canSubmit = Boolean(name) && files.length > 0 && instances.length > 0 && !validationError

  function renderOptionField(index: number, key: string, opt: CompressorOption) {
    const value = instances[index]?.options[key]

    if (opt.type === 'boolean') {
      return (
        <Switch
          checked={(value as boolean) || false}
          onCheckedChange={(v) => updateInstanceOption(index, key, v)}
        />
      )
    }

    if (opt.type === 'select') {
      return (
        <select
          className="flex h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          value={(value as string) || ''}
          onChange={(e) => updateInstanceOption(index, key, e.target.value)}
        >
          {opt.options?.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      )
    }

    if (opt.type === 'number' && opt.min != null && opt.max != null) {
      if (shouldUseSlider(opt)) {
        return (
          <div className="flex items-center gap-2">
            <Slider
              min={opt.min}
              max={opt.max}
              step={opt.step ?? 1}
              value={(value as number) ?? (opt.default as number)}
              onChange={(v) => updateInstanceOption(index, key, v)}
            />
            <span className="text-xs text-muted-foreground w-6 text-right">{value as number}</span>
          </div>
        )
      }
      return (
        <Input
          type="number"
          className="h-8 w-24"
          min={opt.min}
          max={opt.max}
          step={opt.step ?? 1}
          value={(value as number) ?? 0}
          onChange={(e) => updateInstanceOption(index, key, Number(e.target.value))}
        />
      )
    }

    return null
  }

  // Family list for the picker (filtered by search); user packages first.
  const pickerFamilies = useMemo(() => {
    const query = search.trim().toLowerCase()
    const matches = (c: string) => query === '' || c.toLowerCase().includes(query)
    const grids = FAMILIES.map((family) => ({
      ...family,
      compressors: family.compressors.filter((c) => c in compressors && matches(c)),
    })).filter((f) => f.compressors.length > 0)

    const custom = [...customNames].filter(matches).sort()
    if (custom.length > 0) {
      return [{ name: 'Custom', compressors: custom }, ...grids]
    }
    return grids
  }, [compressors, customNames, search])

  const instanceCount = (compName: string) => instances.filter((i) => i.name === compName).length

  return (
    <div className="max-w-6xl mx-auto">
      <form onSubmit={handleSubmit}>
        {/* Zone 1: Title + Benchmark Name */}
        <div className="mb-10">
          <h1 className="text-2xl font-semibold tracking-tight mb-1">New Benchmark</h1>
          <p className="text-sm text-muted-foreground mb-6">
            Upload an integer sequence file and configure the compressors to test.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="name">Benchmark Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My benchmark"
              required
              className="max-w-md"
            />
          </div>
        </div>

        {/* Zone 2: File Upload */}
        <div className="mb-10">
          <h2 className="text-sm font-medium text-foreground mb-3">Data File</h2>
          <div className="space-y-3">
            {/* File format info */}
            <div className="text-xs text-muted-foreground bg-secondary/30 rounded-lg p-3 space-y-1">
              <p><strong>Accepted formats:</strong> <code>.bin</code> (binary integer sequences), <code>.csv</code> (one column per sequence), <code>.zip</code> / <code>.tar</code> (multiple <code>.bin</code> inside).</p>
              <p><strong>Binary header:</strong> 16-byte <code>(N + decimals + N×int64)</code> or 8-byte <code>(N + N×int64)</code> — auto-detected.</p>
              <p>Select multiple files to average results or run sequential benchmarks.</p>
            </div>

          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={[
              'relative rounded-lg border-2 border-dashed transition-colors',
              dragOver ? 'border-foreground bg-secondary/30' : '',
              'border-border hover:border-muted-foreground/40',
            ].filter(Boolean).join(' ')}
          >
            {files.length > 0 ? (
              <div className="p-5">
                {/* Show at most five files; longer selections scroll. */}
                <div data-testid="file-list" className="max-h-[13rem] overflow-y-auto pr-1">
                  {files.map((f, idx) => (
                    <div key={`${f.name}-${idx}`} className="flex items-center justify-between gap-3 mb-2 last:mb-0">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileUp className="w-5 h-5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{f.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(f.size / 1024).toFixed(1)} KB
                            {idx === 0 && ' · Ready'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {idx === 0 && (
                          <span className="flex items-center gap-1 text-xs text-emerald-600">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Ready
                          </span>
                        )}
                        <button
                          type="button"
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => { setFiles([]); setError('') }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Remove all files
                  </button>
                  <span className="text-xs text-muted-foreground">{files.length} files</span>
                </div>
                {files.length > 1 && (
                  <div className="mt-3 flex items-center gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="multiMode"
                        checked={multiMode === 'average'}
                        onChange={() => setMultiMode('average')}
                      />
                      Average results
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="multiMode"
                        checked={multiMode === 'sequential'}
                        onChange={() => setMultiMode('sequential')}
                      />
                      Run separate benchmarks
                    </label>
                    {multiMode === 'sequential' && (
                      <span className="text-xs text-muted-foreground">
                        Named: {name} (filename)
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center p-8 cursor-pointer">
                <FileUp className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground mb-0.5">
                  Drag & drop your file(s) here
                </p>
                <p className="text-xs text-muted-foreground">
                  .bin, .csv, .zip, or .tar — max 500 MB each
                </p>
                <input
                  type="file"
                  className="hidden"
                  accept=".bin,.csv,.zip,.tar"
                  multiple
                  onChange={handleFileInput}
                />
              </label>
            )}
          </div>
          </div>
        </div>

        {/* Zone 3: Configuration builder */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-foreground">Compressor Configuration</h2>
            <span className="text-xs text-muted-foreground">
              {instances.length}/{MAX_INSTANCES_PER_BENCHMARK} instances
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Picker */}
            <div className="border border-border rounded-lg">
              <div className="p-3 border-b border-border">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search compressors..."
                    className="h-8 pl-8"
                  />
                </div>
              </div>
              <div className="max-h-[28rem] overflow-y-auto p-3 space-y-4">
                {Object.keys(compressors).length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading compressors…
                  </div>
                ) : pickerFamilies.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No compressor matches the search.</p>
                ) : (
                  pickerFamilies.map((family) => (
                    <section key={family.name}>
                      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                        {family.name}
                      </h3>
                      <div className="space-y-0.5">
                        {family.compressors.map((c) => {
                          const schema = compressors[c] || {}
                          const variable = hasVariableOptions(schema)
                          const already = instanceCount(c) > 0
                          const disabled = instances.length >= MAX_INSTANCES_PER_BENCHMARK || (!variable && already)
                          return (
                            <div key={c} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-secondary/40">
                              <span className="font-mono text-sm truncate">{renameCompressor(c)}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 shrink-0"
                                disabled={disabled}
                                title={!variable && already ? 'This compressor has no configurable options' : undefined}
                                onClick={() => addInstance(c)}
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>

            {/* Configured instances */}
            <div className="border border-border rounded-lg">
              <div className="p-3 border-b border-border">
                <h3 className="text-sm font-medium">Configured Instances</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Every instance is benchmarked separately; identical configurations are rejected.
                </p>
              </div>
              <div className="max-h-[28rem] overflow-y-auto p-3 space-y-2">
                {instances.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">
                    No compressors configured yet. Add one from the list on the left.
                  </p>
                ) : (
                  instances.map((inst, index) => {
                    const schema = compressors[inst.name] || {}
                    const label = renameCompressor(buildLabel(inst.name, schema, inst.options))
                    const expanded = expandedInstance === index
                    return (
                      <div key={index} className="border border-border rounded-md">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          <button
                            type="button"
                            className="flex-1 text-left min-w-0"
                            onClick={() => setExpandedInstance(expanded ? null : index)}
                          >
                            <span className={`font-mono text-sm truncate ${expanded ? 'font-semibold' : ''}`}>{label}</span>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 shrink-0"
                            aria-label={`Remove ${label}`}
                            onClick={() => removeInstance(index)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                        {expanded && (
                          <div className="px-2 pb-2 border-t border-border pt-2">
                            {Object.keys(schema).length > 0 ? (
                              <div className="space-y-2">
                                {Object.entries(schema).map(([key, opt]) => (
                                  <div key={key} className="flex items-center gap-2">
                                    <Label className="text-xs w-24 shrink-0 text-muted-foreground">{key}</Label>
                                    {renderOptionField(index, key, opt)}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground italic">No configuration options</p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>

          {validationError && (
            <p className="text-xs text-destructive mt-2">{validationError}</p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 mb-4 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Submit */}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!canSubmit || loading} className="min-w-[180px]">
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Submitting…
              </span>
            ) : (
              'Run Benchmark'
            )}
          </Button>
          {!canSubmit && !loading && (
            <p className="text-xs text-muted-foreground">
              {!name && 'Enter a name'}
              {name && files.length === 0 && ' · Select a file'}
              {name && files.length > 0 && instances.length === 0 && ' · Configure at least one compressor'}
              {name && files.length > 0 && instances.length > 0 && validationError && ` · ${validationError}`}
            </p>
          )}
        </div>
      </form>
    </div>
  )
}
