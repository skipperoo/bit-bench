import { useState, useCallback, useEffect, useMemo, useRef, memo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Loader2, FileUp, AlertCircle, CheckCircle2, AlertTriangle, X, Plus, Trash2, Search } from 'lucide-react'
import { apiFetch, apiUploadWithProgress } from '@/lib/api'
import type { UploadProgress } from '@/lib/api'
import { shouldUseSlider } from '@/lib/options'
import { renameCompressor } from '@/lib/compressors'
import { canManagePreset, summarizeInstances } from '@/lib/presets'
import { emulatedSelection, isEmulated, platformArch } from '@/lib/platforms'
import { batchFileStatuses, sequentialFileStatuses } from '@/lib/upload-progress'
import type { FileUploadStatus, UploadPhase } from '@/lib/upload-progress'
import { useAuthStore } from '@/stores/auth-store'
import {
  MAX_INSTANCES_PER_BENCHMARK,
  buildLabel,
  canAddInstance,
  canonicalOptions,
  defaultOptions,
  hasVariableOptions,
  validateInstances,
} from '@/lib/instances'
import type { InstanceDraft } from '@/lib/instances'
import type {
  CompressorRegistry,
  CompressorOption,
  CompressorInstance,
  BenchmarkPreset,
  ConfigHistoryEntry,
  CompressorPackage,
  Config,
} from '@/types'

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

/** Per-file status shown in the upload list. */
function FileStatusBadge({ status }: { status: FileUploadStatus }) {
  switch (status) {
    case 'uploading':
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Uploading
        </span>
      )
    case 'sent':
      return (
        <span className="flex items-center gap-1 text-xs text-emerald-600">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Uploaded
        </span>
      )
    case 'processing':
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Processing
        </span>
      )
    case 'done':
      return (
        <span className="flex items-center gap-1 text-xs text-emerald-600">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Done
        </span>
      )
    case 'error':
      return (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="w-3.5 h-3.5" />
          Failed
        </span>
      )
    default:
      return <span className="text-xs text-muted-foreground">Ready</span>
  }
}

interface FileRowProps {
  file: File
  index: number
  status: FileUploadStatus
  removable: boolean
  onRemove: (index: number) => void
}

/**
 * One row of the selected-files list. Memoized so large selections only pay
 * for rows whose status actually changed.
 */
const FileRow = memo(function FileRow({ file, index, status, removable, onRemove }: FileRowProps) {
  return (
    <div data-status={status} className="file-row flex items-center justify-between gap-3 mb-2 last:mb-0">
      <div className="flex items-center gap-3 min-w-0">
        <FileUp className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{file.name}</p>
          <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <FileStatusBadge status={status} />
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          disabled={!removable}
          onClick={() => onRemove(index)}
          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
})

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
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle')
  const [uploadLoaded, setUploadLoaded] = useState(0)
  const [uploadTotal, setUploadTotal] = useState(0)
  const [uploadIndex, setUploadIndex] = useState(0)
  const restoredRef = useRef(false)

  const role = useAuthStore((s) => s.getRole)()
  const userId = useAuthStore((s) => s.getUserID)()
  const groupId = useAuthStore((s) => s.getGroupID)()
  const [presets, setPresets] = useState<BenchmarkPreset[]>([])
  const [history, setHistory] = useState<ConfigHistoryEntry[]>([])
  const [presetName, setPresetName] = useState('')
  const [presetVisibility, setPresetVisibility] = useState<'private' | 'group'>('private')
  const [presetError, setPresetError] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [hostPlatform, setHostPlatform] = useState('')
  const [packagePlatforms, setPackagePlatforms] = useState<Record<string, string | undefined>>({})

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

  const emulatedSelected = useMemo(
    () => emulatedSelection(instances, packagePlatforms, hostPlatform),
    [instances, packagePlatforms, hostPlatform]
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

  const loadPresets = useCallback(() => {
    apiFetch<BenchmarkPreset[]>('/presets')
      .then((data) => setPresets(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const loadHistory = useCallback(() => {
    apiFetch<ConfigHistoryEntry[]>('/config-history')
      .then((data) => setHistory(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  useEffect(() => { loadPresets(); loadHistory() }, [loadPresets, loadHistory])

  // Host platform and custom-package platforms drive the emulation warning.
  useEffect(() => {
    apiFetch<Config>('/config')
      .then((config) => setHostPlatform(config?.hostPlatform || ''))
      .catch(() => {})
    apiFetch<CompressorPackage[]>('/compressors/packages')
      .then((packages) => {
        if (!Array.isArray(packages)) return
        const platforms: Record<string, string | undefined> = {}
        for (const pkg of packages) {
          if (pkg.status !== 'ready') continue
          platforms[pkg.name] = pkg.platform
        }
        setPackagePlatforms(platforms)
      })
      .catch(() => {})
  }, [])

  const applyInstances = useCallback((incoming: CompressorInstance[]) => {
    if (Object.keys(compressors).length === 0) {
      setPresetError('The compressor list is still loading — try again in a moment.')
      return
    }
    const drafts: InstanceDraft[] = []
    for (const item of incoming) {
      const schema = compressors[item.name]
      if (!schema) continue
      drafts.push({ name: item.name, options: canonicalOptions(schema, item.options || {}) })
    }
    setInstances(drafts.slice(0, MAX_INSTANCES_PER_BENCHMARK))
    setExpandedInstance(null)
    setError('')
  }, [compressors])

  const handleLoadPreset = useCallback((preset: BenchmarkPreset) => {
    if (instances.length > 0 && !confirm(`Replace the current configuration with "${preset.name}"?`)) return
    applyInstances(preset.compressors)
  }, [instances.length, applyInstances])

  const handleDeletePreset = useCallback(async (preset: BenchmarkPreset) => {
    if (!confirm(`Delete preset "${preset.name}"?`)) return
    try {
      await apiFetch(`/presets/${preset.id}`, { method: 'DELETE' })
      loadPresets()
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : 'Delete failed')
    }
  }, [loadPresets])

  const handleSavePreset = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!presetName.trim() || instances.length === 0) return
    setSavingPreset(true)
    setPresetError('')
    try {
      await apiFetch('/presets', {
        method: 'POST',
        body: JSON.stringify({
          name: presetName.trim(),
          visibility: presetVisibility,
          compressors: instances.map((inst) => ({ name: inst.name, options: inst.options })),
        }),
      })
      setPresetName('')
      loadPresets()
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingPreset(false)
    }
  }, [presetName, presetVisibility, instances, loadPresets])

  const handleHistoryLoad = useCallback((entry: ConfigHistoryEntry) => {
    if (instances.length > 0 && !confirm('Replace the current configuration with this saved one?')) return
    applyInstances(entry.compressors)
  }, [instances.length, applyInstances])

  const handleHistoryToPreset = useCallback((entry: ConfigHistoryEntry) => {
    applyInstances(entry.compressors)
    setPresetError('')
    requestAnimationFrame(() => {
      document.getElementById('preset-name')?.focus()
    })
  }, [applyInstances])

  const handleFileChange = useCallback((newFiles: File[]) => {
    // Update the list synchronously so it appears as soon as the selection
    // returns, before any other work.
    setFiles(newFiles)
    setUploadPhase('idle')
    setUploadLoaded(0)
    setUploadTotal(0)
    setUploadIndex(0)
    if (newFiles.length === 0) return
    // Autocomplete benchmark name from first filename (without extension)
    if (!name) {
      const base = newFiles[0].name.replace(/\.[^.]+$/, '')
      setName(base)
    }
    setError('')
  }, [name])

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setUploadPhase('idle')
    setUploadLoaded(0)
    setUploadTotal(0)
    setUploadIndex(0)
  }, [])

  const fileStatuses = useMemo(() => {
    if (files.length === 0) return []
    if (multiMode === 'sequential' && files.length > 1) {
      return sequentialFileStatuses(files.length, uploadIndex, uploadPhase)
    }
    return batchFileStatuses(files, uploadPhase, uploadLoaded, uploadTotal)
  }, [files, multiMode, uploadIndex, uploadPhase, uploadLoaded, uploadTotal])

  const uploadPercent = uploadTotal > 0 ? Math.round((uploadLoaded / uploadTotal) * 100) : null

  const fileListSummary = useMemo(() => {
    if (!loading) return `${files.length} files`
    if (uploadPhase === 'processing') return 'Upload complete — processing on the server…'
    if (uploadPhase === 'done') return 'Uploaded'
    if (uploadPhase === 'uploading') {
      const prefix = multiMode === 'sequential' && files.length > 1
        ? `Uploading file ${uploadIndex + 1} of ${files.length}`
        : 'Uploading'
      return uploadPercent !== null ? `${prefix} — ${uploadPercent}%` : `${prefix}…`
    }
    return 'Submitting…'
  }, [loading, files.length, uploadPhase, multiMode, uploadIndex, uploadPercent])

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

  const handleSubmit = async () => {
    if (!name || files.length === 0 || validationError || loading) return
    setLoading(true)
    setError('')
    setUploadLoaded(0)
    setUploadTotal(0)
    setUploadIndex(0)
    try {
      const compressorsPayload = instances.map((inst) => ({ name: inst.name, options: inst.options }))

      // Save config for next time
      apiFetch('/me/config', {
        method: 'PUT',
        body: JSON.stringify({ compressors: compressorsPayload }),
      }).catch(() => {})

      const reportProgress = (progress: UploadProgress) => {
        setUploadLoaded(progress.loaded)
        setUploadTotal(progress.total)
        // All bytes are handed to the socket: the server is now normalizing
        // the files and creating the task rows.
        if (progress.total > 0 && progress.loaded >= progress.total) {
          setUploadPhase('processing')
        }
      }

      if (files.length === 1 || multiMode === 'average') {
        // One benchmark; all files are processed in parallel and averaged.
        setUploadPhase('uploading')
        const formData = new FormData()
        formData.append('name', multiMode === 'average' && files.length > 1
          ? `${name} (avg ${files.length})` : name)
        for (const f of files) {
          formData.append('files', f)
        }
        formData.append('compressors', JSON.stringify(compressorsPayload))
        await apiUploadWithProgress<{ id: string }>('/benchmarks', formData, reportProgress)
        setUploadPhase('done')
        navigate(`/results`)
      } else {
        // Sequential mode: enqueue each file as a separate benchmark
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          setUploadIndex(i)
          setUploadLoaded(0)
          setUploadTotal(0)
          setUploadPhase('uploading')
          const fname = f.name.replace(/\.[^.]+$/, '')
          const formData = new FormData()
          formData.append('name', `${name} (${fname})`)
          formData.append('files', f)
          formData.append('compressors', JSON.stringify(compressorsPayload))
          await apiUploadWithProgress<{ id: string }>('/benchmarks', formData, reportProgress)
          setUploadPhase('done')
          if (i === files.length - 1) {
            navigate(`/results`)
          }
        }
      }
    } catch (err) {
      setUploadPhase('error')
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
      <div>
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
              placeholder="My benchmark"
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
                    <FileRow
                      key={`${f.name}-${idx}`}
                      file={f}
                      index={idx}
                      status={fileStatuses[idx] ?? 'ready'}
                      removable={!loading}
                      onRemove={removeFile}
                    />
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => { setFiles([]); setError(''); setUploadPhase('idle') }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  >
                    Remove all files
                  </button>
                  <span data-testid="file-summary" className="text-xs text-muted-foreground">{fileListSummary}</span>
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

        {/* Zone 3: Presets and configuration history */}
        <div className="mb-10">
          <h2 className="text-sm font-medium text-foreground mb-3">Presets &amp; History</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Presets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {presets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No presets yet. Configure the compressors below and save them for later.
                  </p>
                ) : (
                  <div className="max-h-56 overflow-y-auto space-y-0.5">
                    {presets.map((preset) => (
                      <div key={preset.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-secondary/40">
                        <div className="min-w-0">
                          <p className="text-sm truncate">
                            {preset.name}{' '}
                            <Badge variant={preset.visibility === 'group' ? 'secondary' : 'outline'} className="text-xs">
                              {preset.visibility === 'group' ? 'group' : 'private'}
                            </Badge>
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{summarizeInstances(preset.compressors)}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button type="button" variant="outline" size="sm" className="h-7 px-2" onClick={() => handleLoadPreset(preset)}>
                            Load
                          </Button>
                          {canManagePreset(role, userId, groupId, preset) && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              aria-label={`Delete ${preset.name}`}
                              onClick={() => handleDeletePreset(preset)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <form onSubmit={handleSavePreset} className="flex items-end gap-2 pt-3 border-t border-border">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="preset-name" className="text-xs">Save current configuration</Label>
                    <Input
                      id="preset-name"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      placeholder="Preset name"
                      className="h-8"
                      maxLength={100}
                    />
                  </div>
                  <select
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                    value={presetVisibility}
                    onChange={(e) => setPresetVisibility(e.target.value as 'private' | 'group')}
                    title="Preset visibility"
                  >
                    <option value="private">Private</option>
                    <option value="group" disabled={!groupId}>Group</option>
                  </select>
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8"
                    disabled={!presetName.trim() || instances.length === 0 || savingPreset}
                  >
                    {savingPreset ? 'Saving…' : 'Save'}
                  </Button>
                </form>
                {presetError && <p className="text-xs text-destructive">{presetError}</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent Configurations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Configurations used in previous benchmarks appear here and can be promoted to presets.
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto space-y-0.5">
                    {history.map((entry) => (
                      <div key={entry.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-secondary/40">
                        <div className="min-w-0">
                          <p className="text-xs font-mono truncate">{summarizeInstances(entry.compressors)}</p>
                          <p className="text-xs text-muted-foreground">
                            Last used {new Date(entry.last_used_at).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button type="button" variant="outline" size="sm" className="h-7 px-2" onClick={() => handleHistoryLoad(entry)}>
                            Load
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => handleHistoryToPreset(entry)}>
                            Save as preset
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Zone 4: Configuration builder */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-foreground">Compressor Configuration</h2>
            <span className="text-xs text-muted-foreground">
              {instances.length}/{MAX_INSTANCES_PER_BENCHMARK} instances
            </span>
          </div>

          {emulatedSelected.length > 0 && (
            <div
              data-testid="emulation-warning"
              className="flex items-start gap-2 mb-4 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">CPU emulation — throughput is not representative</p>
                <p className="text-xs mt-1">
                  {emulatedSelected.map((item) => `${item.name} (${platformArch(item.platform)})`).join(', ')}
                  {' '}target{emulatedSelected.length === 1 ? 's' : ''} a different architecture than this host
                  {hostPlatform ? ` (${platformArch(hostPlatform)})` : ''} and will run under emulation.
                  Compression ratio and memory are reliable; throughput numbers are distorted and must not be
                  compared directly with native runs.
                </p>
              </div>
            </div>
          )}

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
                          const disabled = !canAddInstance(schema, customNames.has(c), instanceCount(c), instances.length)
                          const emulated = isEmulated(packagePlatforms[c], hostPlatform)
                          return (
                            <div key={c} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-secondary/40">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="font-mono text-sm truncate">{renameCompressor(c)}</span>
                                {emulated && (
                                  <span
                                    className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium text-amber-800"
                                    title={`Targets ${platformArch(packagePlatforms[c])} — runs under emulation on this host`}
                                  >
                                    {platformArch(packagePlatforms[c])} emulated
                                  </span>
                                )}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 shrink-0"
                                aria-label={`Add ${renameCompressor(c)}`}
                                disabled={disabled}
                                title={!customNames.has(c) && !hasVariableOptions(compressors[c] || {}) && instanceCount(c) > 0
                                  ? 'This compressor has no configurable options'
                                  : undefined}
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
                    const emulated = isEmulated(packagePlatforms[inst.name], hostPlatform)
                    return (
                      <div key={index} className="border border-border rounded-md">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          <button
                            type="button"
                            className="flex-1 text-left min-w-0"
                            onClick={() => setExpandedInstance(expanded ? null : index)}
                          >
                            <span className="flex items-center gap-1.5 min-w-0">
                              <span className={`font-mono text-sm truncate ${expanded ? 'font-semibold' : ''}`}>{label}</span>
                              {emulated && (
                                <span
                                  data-testid={`emulated-${inst.name}`}
                                  className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium text-amber-800"
                                  title={`Targets ${platformArch(packagePlatforms[inst.name])} — runs under emulation on this host`}
                                >
                                  {platformArch(packagePlatforms[inst.name])} emulated
                                </span>
                              )}
                            </span>
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
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit || loading} className="min-w-[180px]">
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {uploadPhase === 'processing' ? 'Processing…' : 'Uploading…'}
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
      </div>
    </div>
  )
}
