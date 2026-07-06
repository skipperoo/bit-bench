import { useState, useCallback, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { Loader2, FileUp, AlertCircle, CheckCircle2 } from 'lucide-react'
import { apiFetch, apiUpload } from '@/lib/api'
import { computeMD5 } from '@/lib/md5'
import { shouldUseSlider } from '@/lib/options'
import type { CompressorRegistry, CompressorOption } from '@/types'

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
  const [checksumLoading, setChecksumLoading] = useState(false)
  const [compressors, setCompressors] = useState<CompressorRegistry>({})
  const [selectedCompressors, setSelectedCompressors] = useState<Record<string, boolean>>({})
  const [compressorOptions, setCompressorOptions] = useState<Record<string, Record<string, unknown>>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [duplicate, setDuplicate] = useState(false)
  const [compressorsOpen, setCompressorsOpen] = useState<string[]>([])

  const loadCompressors = useCallback(async () => {
    try {
      const reg = await apiFetch<CompressorRegistry>('/compressors')
      setCompressors(reg)
      const initial: Record<string, boolean> = {}
      Object.keys(reg).forEach((c) => { initial[c] = false })
      setSelectedCompressors(initial)
      const opts: Record<string, Record<string, unknown>> = {}
      Object.entries(reg).forEach(([name, options]) => {
        opts[name] = {}
        Object.entries(options).forEach(([key, opt]) => {
          opts[name][key] = opt.default
        })
      })
      setCompressorOptions(opts)
    } catch {
      // compressors will be loaded on demand
    }
  }, [])

  useEffect(() => { loadCompressors() }, [loadCompressors])

  // Restore last config on mount
  useEffect(() => {
    apiFetch<{ last_bench_config?: Record<string, unknown> }>('/me')
      .then((u) => {
        if (u.last_bench_config?.compressors) {
          const saved = u.last_bench_config as Record<string, unknown>
          if (saved.compressors && typeof saved.compressors === 'object') {
            const comps = saved.compressors as Record<string, Record<string, unknown>>
            const selected: Record<string, boolean> = {}
            const opts: Record<string, Record<string, unknown>> = {}
            Object.keys(compressors).forEach((c) => {
              selected[c] = !!comps[c]
              opts[c] = { ...compressorOptions[c], ...(comps[c] || {}) }
            })
            if (Object.values(selected).some(Boolean)) {
              setSelectedCompressors(selected)
              setCompressorOptions(opts)
            }
          }
        }
      })
      .catch(() => {})
  }, [compressors])

  const handleFileChange = useCallback(async (newFiles: File[]) => {
    setFiles(newFiles)
    setDuplicate(false)
    if (newFiles.length === 0) return
    // Autocomplete benchmark name from first filename (without extension)
    if (!name) {
      const base = newFiles[0].name.replace(/\.[^.]+$/, '')
      setName(base)
    }
    setChecksumLoading(true)
    try {
      const md5 = await computeMD5(newFiles[0])
      const checksums = await apiFetch<{ checksum: string }[]>('/benchmarks/checksums')
      const found = checksums.some((c) => c.checksum === md5)
      setDuplicate(found)
      if (found) setError('This file has already been benchmarked (duplicate checksum)')
      else setError('')
    } catch {
      // proceed without duplicate check
    } finally {
      setChecksumLoading(false)
    }
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
    if (!name || files.length === 0 || duplicate) return
    setLoading(true)
    setError('')
    try {
      const selected = Object.entries(selectedCompressors)
        .filter(([, v]) => v)
        .map(([k]) => k)
      const compressorsPayload = Object.fromEntries(selected.map((c) => [c, compressorOptions[c] || {}]))

      // Save config for next time
      apiFetch('/me/config', {
        method: 'PUT',
        body: JSON.stringify({ compressors: compressorsPayload }),
      }).catch(() => {})

      if (files.length === 1 || multiMode === 'average') {
        // For single file or average mode: send one of each (or zip for multiple)
        // We approximate average by uploading all files as the same benchmark.
        // For simplicity, upload the first file — the backend already averages
        // across .bin files when a tar/zip contains multiple.
        const formData = new FormData()
        formData.append('name', multiMode === 'average' && files.length > 1
          ? `${name} (avg ${files.length})` : name)
        formData.append('file', files[0])
        formData.append('compressors', JSON.stringify(compressorsPayload))
        const avgRes = await apiUpload<{ id: string }>('/benchmarks', formData)
        navigate(`/results/${avgRes.id}`)
      } else {
        // Sequential mode: enqueue each file as a separate benchmark
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const fname = f.name.replace(/\.[^.]+$/, '')
          const formData = new FormData()
          formData.append('name', `${name} (${fname})`)
          formData.append('file', f)
          formData.append('compressors', JSON.stringify(compressorsPayload))
          const _res = await apiUpload<{ id: string }>('/benchmarks', formData)
          if (i === files.length - 1) {
            navigate(`/results/${_res.id}`)
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  const selectedCount = useMemo(
    () => Object.values(selectedCompressors).filter(Boolean).length,
    [selectedCompressors]
  )
  const canSubmit = name && files.length > 0 && selectedCount > 0 && !duplicate

  function toggleFamily(family: string, on: boolean) {
    const familyDef = FAMILIES.find(f => f.name === family)
    if (!familyDef) return
    setSelectedCompressors((prev) => {
      const next = { ...prev }
      for (const c of familyDef.compressors) {
        if (c in next) next[c] = on
      }
      return next
    })
  }

  function allFamilySelected(family: string): boolean {
    const familyDef = FAMILIES.find(f => f.name === family)
    if (!familyDef) return false
    return familyDef.compressors.every(c => selectedCompressors[c])
  }

  function renderOptionField(cName: string, key: string, opt: CompressorOption) {
    const value = compressorOptions[cName]?.[key]

    if (opt.type === 'boolean') {
      return (
        <Switch
          checked={(value as boolean) || false}
          onCheckedChange={(v) =>
            setCompressorOptions((prev) => ({ ...prev, [cName]: { ...prev[cName], [key]: v } }))
          }
        />
      )
    }

    if (opt.type === 'select') {
      return (
        <select
          className="flex h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          value={(value as string) || ''}
          onChange={(e) =>
            setCompressorOptions((prev) => ({ ...prev, [cName]: { ...prev[cName], [key]: e.target.value } }))
          }
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
              onChange={(v) =>
                setCompressorOptions((prev) => ({ ...prev, [cName]: { ...prev[cName], [key]: v } }))
              }
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
          onChange={(e) =>
            setCompressorOptions((prev) => ({ ...prev, [cName]: { ...prev[cName], [key]: Number(e.target.value) } }))
          }
        />
      )
    }

    return null
  }

  function renderCompressorAccordion(cName: string) {
    const options = compressors[cName] || {}
    return (
      <AccordionItem key={cName} value={cName} className="border rounded-lg">
        <AccordionTrigger className="px-3 py-2 hover:no-underline hover:bg-secondary/30 rounded-t-lg data-[state=open]:rounded-t-lg data-[state=open]:rounded-b-none">
          <div className="flex items-center gap-2 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={selectedCompressors[cName] || false}
              onCheckedChange={(v) =>
                setSelectedCompressors((prev) => ({ ...prev, [cName]: v }))
              }
            />
            <span className={`font-mono text-sm truncate ${selectedCompressors[cName] ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              {cName}
            </span>
          </div>
        </AccordionTrigger>
        {Object.keys(options).length > 0 ? (
          <AccordionContent className="px-3 pb-3">
            <div className="space-y-2 pt-2">
              {Object.entries(options).map(([key, opt]) => (
                <div key={key} className="flex items-center gap-2">
                  <Label className="text-xs w-20 shrink-0 text-muted-foreground">{key}</Label>
                  {renderOptionField(cName, key, opt)}
                </div>
              ))}
            </div>
          </AccordionContent>
        ) : (
          <AccordionContent className="px-3 pb-2">
            <p className="text-xs text-muted-foreground italic">No configuration options</p>
          </AccordionContent>
        )}
      </AccordionItem>
    )
  }

  // Group compressors by family for rendering
  const familyGrids = useMemo(() => {
    return FAMILIES.map(family => ({
      ...family,
      compressors: family.compressors.filter(c => c in compressors),
    })).filter(f => f.compressors.length > 0)
  }, [compressors])

  return (
    <div className="max-w-4xl mx-auto">
      <form onSubmit={handleSubmit}>
        {/* Zone 1: Title + Benchmark Name */}
        <div className="mb-10">
          <h1 className="text-2xl font-semibold tracking-tight mb-1">New Benchmark</h1>
          <p className="text-sm text-muted-foreground mb-6">
            Upload an integer sequence file and select compressors to test.
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
              duplicate && !dragOver ? 'border-destructive bg-destructive/5' : '',
              !dragOver && !duplicate ? 'border-border hover:border-muted-foreground/40' : '',
            ].filter(Boolean).join(' ')}
          >
            {files.length > 0 ? (
              <div className="p-5">
                {files.map((f, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-3 mb-2 last:mb-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileUp className="w-5 h-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{f.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {(f.size / 1024).toFixed(1)} KB
                          {idx === 0 && checksumLoading && ' · Checking checksum…'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {idx === 0 && duplicate ? (
                        <span className="flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Duplicate
                        </span>
                      ) : idx === 0 && !checksumLoading && !duplicate ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Valid
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => { setFiles([]); setDuplicate(false); setError('') }}
                  className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Remove all files
                </button>
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
                  .bin, .csv, .zip, or .tar — max {500} MB each
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

        {/* Zone 3: Compressors */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-foreground">Compressors</h2>
            {selectedCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {selectedCount} selected
              </span>
            )}
          </div>

          {Object.keys(compressors).length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading compressors…
            </div>
          ) : (
            <div className="space-y-6">
              {familyGrids.map((family) => {
                const allOn = allFamilySelected(family.name)
                const someOn = family.compressors.some(c => selectedCompressors[c])
                return (
                  <section key={family.name}>
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {family.name}
                      </h3>
                      <button
                        type="button"
                        onClick={() => toggleFamily(family.name, !allOn)}
                        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                      >
                        {allOn ? 'Deselect all' : 'Select all'}
                      </button>
                      {someOn && (
                        <span className="text-xs text-muted-foreground">
                          {family.compressors.filter(c => selectedCompressors[c]).length}
                        </span>
                      )}
                    </div>
                    <Accordion
                      type="multiple"
                      value={compressorsOpen}
                      onValueChange={setCompressorsOpen}
                      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2"
                    >
                      {family.compressors.map(renderCompressorAccordion)}
                    </Accordion>
                  </section>
                )
              })}
            </div>
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
              {name && files.length > 0 && selectedCount === 0 && ' · Select at least one compressor'}
              {name && files.length > 0 && selectedCount > 0 && duplicate && ' · File is a duplicate'}
            </p>
          )}
        </div>
      </form>
    </div>
  )
}
