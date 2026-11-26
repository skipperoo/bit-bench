import { Fragment, useState, useCallback, useEffect, useMemo, useRef, memo } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Loader2, FileUp, AlertCircle, CheckCircle2, AlertTriangle, X, Plus, Trash2, Search, ChevronLeft } from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { useIsPhone } from '@/lib/responsive'
import { apiFetch, apiUploadWithProgress } from '@/lib/api'
import type { UploadProgress } from '@/lib/api'
import { shouldUseSlider } from '@/lib/options'
import { useChartStyles } from '@/stores/chart-styles-store'
import { assignCompressorStyles, packageColor, registerCompressorColors, renameCompressor } from '@/lib/compressors'
import CompressorSwatch from '@/components/CompressorSwatch'
import { formatBytes } from '@/lib/format'
import { canManagePreset, summarizeInstances } from '@/lib/presets'
import { emulatedSelection, isEmulated, platformArch } from '@/lib/platforms'
import { batchFileStatuses } from '@/lib/upload-progress'
import { ACCEPTED_EXTENSIONS, checkUploadFiles } from '@/lib/files'
import { AGGREGATION_INFO, DEFAULT_DATASET_SELECTION, datasetSelectionError, planRuns } from '@/lib/datasets'
import type { Aggregation, DatasetListResponse, DatasetSelection } from '@/lib/datasets'
import DatasetPanel from '@/components/DatasetPanel'
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
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
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
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
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
          <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
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

interface RerunState {
  name?: string
  compressors?: CompressorInstance[] | { name: string; options: Record<string, unknown> }[]
  aggregation?: Aggregation
  measureMemory?: boolean
  /** Dataset runs: every chunk size and transform (older states carry a single chunk_size/transform). */
  source?: { dataset: string; series: string[]; max_chunks: number; chunk_sizes?: number[]; transforms?: string[]; chunk_size?: number; transform?: string }
}

export default function NewExperimentPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const navState = location.state as { rerun?: RerunState; dataset?: string } | null
  const rerun = navState?.rerun
  const presetDataset = navState?.dataset
  const shapeOverrides = useChartStyles((st) => st.shapes)
  const colorOverrides = useChartStyles((st) => st.colors)
  useChartStyles((st) => st.names) // re-render with the user's compressor names
  useEffect(() => { useChartStyles.getState().load() }, [])
  const [name, setName] = useState('')
  // Phones: one step per screen (the sections stay mounted, so nothing typed is lost).
  const phone = useIsPhone()
  const [step, setStep] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [stepHint, setStepHint] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [multiMode, setMultiMode] = useState<'average' | 'sequential'>('average')
  const [source, setSource] = useState<'files' | 'dataset'>('files')
  const [datasetCatalog, setDatasetCatalog] = useState<DatasetListResponse | null>(null)
  const [datasetSelection, setDatasetSelection] = useState<DatasetSelection>(DEFAULT_DATASET_SELECTION)
  const [aggregation, setAggregation] = useState<Aggregation>('mean')
  const [measureMemory, setMeasureMemory] = useState(true)
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
  const [loadOpen, setLoadOpen] = useState(false)
  const [hostPlatform, setHostPlatform] = useState('')
  const [maxFileSizeMb, setMaxFileSizeMb] = useState(0)
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

  // Re-run: start from the configuration of an existing benchmark.
  useEffect(() => {
    if (!rerun || restoredRef.current || Object.keys(compressors).length === 0) return
    restoredRef.current = true
    const drafts: InstanceDraft[] = []
    for (const item of rerun.compressors ?? []) {
      const schema = compressors[item.name]
      if (schema) drafts.push({ name: item.name, options: canonicalOptions(schema, item.options || {}) })
    }
    setInstances(drafts.slice(0, MAX_INSTANCES_PER_BENCHMARK))
    if (rerun.name) setName(`${rerun.name} (re-run)`)
    if (rerun.aggregation) setAggregation(rerun.aggregation)
    if (rerun.measureMemory != null) setMeasureMemory(rerun.measureMemory)
    if (rerun.source) {
      setSource('dataset')
      setDatasetSelection({
        dataset: rerun.source.dataset,
        series: rerun.source.series,
        chunkSizes: rerun.source.chunk_sizes ?? (rerun.source.chunk_size != null ? [rerun.source.chunk_size] : DEFAULT_DATASET_SELECTION.chunkSizes),
        maxChunks: rerun.source.max_chunks,
        transforms: (rerun.source.transforms ?? (rerun.source.transform ? [rerun.source.transform] : DEFAULT_DATASET_SELECTION.transforms)) as DatasetSelection['transforms'],
      })
    }
  }, [rerun, compressors])

  const customNames = useMemo(() => {
    const builtin = new Set(FAMILIES.flatMap((f) => f.compressors))
    return new Set(Object.keys(compressors).filter((c) => !builtin.has(c)))
  }, [compressors])

  const validationError = useMemo(
    () => validateInstances(instances, compressors, customNames),
    [instances, compressors, customNames]
  )

  // Same colour assignment as the result charts (shades per configuration).
  // Not memoized: package colours are registered asynchronously and the
  // computation is trivial.
  const instanceStyles = assignCompressorStyles(
    instances.map((inst) => buildLabel(inst.name, compressors[inst.name] || {}, inst.options)),
    { shapes: shapeOverrides, colors: colorOverrides },
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

  useEffect(() => {
    const empty: DatasetListResponse = { datasets: [], transforms: [], max_runs: 32, max_inputs_per_run: 5000, max_chunks_per_series: 10000 }
    apiFetch<Partial<DatasetListResponse>>('/datasets')
      .then((data) => setDatasetCatalog({
        ...empty,
        ...data,
        datasets: Array.isArray(data?.datasets) ? data.datasets : [],
      }))
      .catch(() => setDatasetCatalog(empty))
  }, [])

  // "Benchmark this dataset" from the Datasets page preselects it.
  const datasetPrefilled = useRef(false)
  useEffect(() => {
    if (!presetDataset || datasetPrefilled.current || !datasetCatalog) return
    const ds = datasetCatalog.datasets.find((d) => d.name === presetDataset)
    if (!ds) return
    datasetPrefilled.current = true
    setSource('dataset')
    setDatasetSelection({ ...DEFAULT_DATASET_SELECTION, dataset: ds.name })
    setName((n) => n || ds.name)
  }, [presetDataset, datasetCatalog])

  const currentDataset = datasetCatalog?.datasets.find((d) => d.name === datasetSelection.dataset)
  const datasetError = useMemo(
    () => datasetSelectionError(datasetSelection, currentDataset, datasetCatalog),
    [datasetSelection, currentDataset, datasetCatalog],
  )

  // Host platform and custom-package platforms drive the emulation warning.
  useEffect(() => {
    apiFetch<Config>('/config')
      .then((config) => {
        setHostPlatform(config?.hostPlatform || '')
        setMaxFileSizeMb(config?.maxFileSizeMb || 0)
      })
      .catch(() => {})
    apiFetch<CompressorPackage[]>('/compressors/packages')
      .then((packages) => {
        if (!Array.isArray(packages)) return
        const platforms: Record<string, string | undefined> = {}
        for (const pkg of packages) {
          if (pkg.status !== 'ready') continue
          platforms[pkg.name] = pkg.platform
        }
        registerCompressorColors(Object.fromEntries(packages.map((pkg) => [pkg.name, packageColor(pkg.spec)])))
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

  const handleFileChange = useCallback((selected: File[]) => {
    const { accepted: newFiles, rejected } = checkUploadFiles(selected, maxFileSizeMb)
    // Update the list synchronously so it appears as soon as the selection
    // returns, before any other work.
    setFiles(newFiles)
    setUploadPhase('idle')
    setUploadLoaded(0)
    setUploadTotal(0)
    setError(rejected.length > 0
      ? `Skipped ${rejected.length} file(s): ${rejected.slice(0, 3).join('; ')}${rejected.length > 3 ? '; …' : ''}`
      : '')
    if (newFiles.length === 0) return
    // Autocomplete benchmark name from first filename (without extension)
    if (!name) {
      const base = newFiles[0].name.replace(/\.[^.]+$/, '')
      setName(base)
    }
  }, [name, maxFileSizeMb])

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setUploadPhase('idle')
    setUploadLoaded(0)
    setUploadTotal(0)
  }, [])

  const fileStatuses = useMemo(() => {
    if (files.length === 0) return []
    return batchFileStatuses(files, uploadPhase, uploadLoaded, uploadTotal)
  }, [files, uploadPhase, uploadLoaded, uploadTotal])

  const uploadPercent = uploadTotal > 0 ? Math.round((uploadLoaded / uploadTotal) * 100) : null

  const fileListSummary = useMemo(() => {
    if (!loading) return `${files.length} files`
    if (uploadPhase === 'processing') return 'Upload complete — processing on the server…'
    if (uploadPhase === 'done') return 'Uploaded'
    if (uploadPhase === 'uploading') {
      return uploadPercent !== null ? `Uploading — ${uploadPercent}%` : 'Uploading…'
    }
    return 'Submitting…'
  }, [loading, files.length, uploadPhase, uploadPercent])

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

  const submitDataset = async (compressorsPayload: { name: string; options: Record<string, unknown> }[]) => {
    setUploadPhase('processing')
    const res = await apiFetch<{ benchmarks: { id: string }[]; error?: string }>('/benchmarks/dataset', {
      method: 'POST',
      body: JSON.stringify({
        name,
        dataset: datasetSelection.dataset,
        series: datasetSelection.series,
        chunk_sizes: datasetSelection.chunkSizes,
        max_chunks: datasetSelection.maxChunks,
        transforms: datasetSelection.transforms,
        aggregation,
        measure_memory: measureMemory,
        compressors: compressorsPayload,
      }),
    })
    if (res?.error) throw new Error(`Created ${res.benchmarks.length} benchmark(s), then: ${res.error}`)
    setUploadPhase('done')
    navigate('/experiments')
  }

  const handleSubmit = async () => {
    const hasInput = source === 'files' ? files.length > 0 : !datasetError
    if (!name || !hasInput || validationError || loading) return
    setLoading(true)
    setError('')
    setUploadLoaded(0)
    setUploadTotal(0)
    try {
      const compressorsPayload = instances.map((inst) => ({ name: inst.name, options: inst.options }))

      // Save config for next time
      apiFetch('/me/config', {
        method: 'PUT',
        body: JSON.stringify({ compressors: compressorsPayload }),
      }).catch(() => {})

      if (source === 'dataset') {
        await submitDataset(compressorsPayload)
        return
      }

      const reportProgress = (progress: UploadProgress) => {
        setUploadLoaded(progress.loaded)
        setUploadTotal(progress.total)
        // All bytes are handed to the socket: the server is now normalizing
        // the files and creating the task rows.
        if (progress.total > 0 && progress.loaded >= progress.total) {
          setUploadPhase('processing')
        }
      }

      // One request in both modes: "average" makes one benchmark of all files,
      // "separate" one benchmark per file (named "<name> (<file>)").
      const separate = multiMode === 'sequential' && files.length > 1
      setUploadPhase('uploading')
      const formData = new FormData()
      formData.append('name', !separate && files.length > 1 ? `${name} (avg ${files.length})` : name)
      if (separate) formData.append('mode', 'separate')
      for (const f of files) {
        formData.append('files', f)
      }
      formData.append('compressors', JSON.stringify(compressorsPayload))
      formData.append('aggregation', aggregation)
      formData.append('measure_memory', String(measureMemory))
      const res = await apiUploadWithProgress<{ id?: string; benchmarks?: { id: string }[]; error?: string }>(
        '/benchmarks', formData, reportProgress,
      )
      if (res?.error) throw new Error(`Created ${res.benchmarks?.length ?? 0} benchmark(s), then: ${res.error}`)
      setUploadPhase('done')
      navigate('/experiments')
    } catch (err) {
      setUploadPhase('error')
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  const inputReady = source === 'files' ? files.length > 0 : !datasetError
  const canSubmit = Boolean(name) && inputReady && instances.length > 0 && !validationError

  const steps = [
    { id: 'step-data', label: 'Data', done: Boolean(name) && inputReady },
    { id: 'step-compressors', label: 'Compressors', done: instances.length > 0 && !validationError },
    { id: 'step-settings', label: 'Run settings', done: true },
  ]

  // What the run will do: benchmarks, inputs and the task count the scheduler sees.
  const customCount = instances.filter((i) => customNames.has(i.name)).length
  const builtinCount = instances.length - customCount
  const tasksPerInput = (builtinCount > 0 ? 1 : 0) + customCount
  const summaryRows: [string, string][] = (() => {
    const rows: [string, string][] = [['Name', name || '—']]
    if (source === 'dataset') {
      const series = (currentDataset?.series ?? []).filter((x) => datasetSelection.series.includes(x.name))
      const runs = planRuns(series, datasetSelection.chunkSizes, datasetSelection.maxChunks, datasetSelection.transforms)
      const inputs = runs.reduce((a, r) => a + r.inputs, 0)
      rows.push(['Data', datasetSelection.dataset ? `${datasetSelection.dataset} · ${series.length} series` : '—'])
      rows.push(['Benchmarks', String(runs.length || '—')])
      rows.push(['Inputs', inputs ? String(inputs) : '—'])
      rows.push(['Tasks', inputs && tasksPerInput ? String(inputs * tasksPerInput) : '—'])
    } else {
      const bytes = files.reduce((a, f) => a + f.size, 0)
      rows.push(['Data', files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(bytes)}` : '—'])
      rows.push(['Benchmarks', files.length > 1 && multiMode === 'sequential' ? String(files.length) : files.length ? '1' : '—'])
      // CSV columns and archive members become separate inputs on the server.
      const exact = files.every((f) => f.name.toLowerCase().endsWith('.bin'))
      rows.push(['Tasks', files.length && tasksPerInput ? `${exact ? '' : '≥ '}${files.length * tasksPerInput}` : '—'])
    }
    rows.push(['Instances', instances.length ? `${builtinCount} built-in, ${customCount} custom` : '—'])
    rows.push(['Aggregation', AGGREGATION_INFO[aggregation].label])
    rows.push(['Memory', measureMemory ? 'Massif (slow)' : 'off'])
    return rows
  })()

  /** Adds the default configuration of every compressor of a family not yet configured. */
  const addAll = (names: string[]) => {
    setInstances((prev) => {
      const next = [...prev]
      for (const c of names) {
        if (next.length >= MAX_INSTANCES_PER_BENCHMARK) break
        if (next.some((i) => i.name === c)) continue
        next.push({ name: c, options: defaultOptions(compressors[c] || {}) })
      }
      return next
    })
    setError('')
  }

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
          aria-label={key}
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

  // The algorithm picker: the left pane on desktop, a sheet on phones.
  const pickerPane = (
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
                      <div className="flex items-center justify-between mb-1.5">
                        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {family.name}
                        </h3>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                          aria-label={`Add all ${family.name}`}
                          disabled={family.compressors.every((c) => instanceCount(c) > 0)}
                          onClick={() => addAll(family.compressors)}
                        >
                          Add all
                        </button>
                      </div>
                      <div className="space-y-0.5">
                        {family.compressors.map((c) => {
                          const schema = compressors[c] || {}
                          const disabled = !canAddInstance(c, schema, customNames.has(c), instanceCount(c), instances.length)
                          const emulated = isEmulated(packagePlatforms[c], hostPlatform)
                          return (
                            <div key={c} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-secondary/40">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <CompressorSwatch name={c} />
                                <span className="font-mono text-sm truncate">{renameCompressor(c)}</span>
                                {emulated && (
                                  <span
                                    className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
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
                                title={!customNames.has(c) && !hasVariableOptions(c, compressors[c] || {}) && instanceCount(c) > 0
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
  )

  const goTo = (next: number) => {
    setStepHint('')
    setStep(next)
    window.scrollTo?.({ top: 0 })
  }
  // Next checks the current step and points at what is missing instead of being a dead button.
  const nextStep = () => {
    if (step === 0 && !steps[0].done) {
      setStepHint(!name ? 'Enter a name' : source === 'files' ? 'Select a file' : datasetError ?? '')
      if (!name) document.getElementById('name')?.focus()
      return
    }
    if (step === 1 && !steps[1].done) {
      setStepHint(instances.length === 0 ? 'Add at least one compressor' : validationError ?? '')
      return
    }
    goTo(step + 1)
  }

  return (
    <div className="max-w-7xl mx-auto max-md:pb-36">
      {phone && (
        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            {step === 0
              ? <Link to="/experiments" viewTransition className="-ml-1 flex items-center text-sm text-muted-foreground"><ChevronLeft className="h-4 w-4" />Cancel</Link>
              : <button type="button" onClick={() => goTo(step - 1)} className="-ml-1 flex items-center text-sm text-muted-foreground"><ChevronLeft className="h-4 w-4" />{steps[step - 1].label}</button>}
            <span className="text-sm font-semibold">{steps[step].label}</span>
            <span className="text-xs text-muted-foreground">{step + 1} of {steps.length}</span>
          </div>
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((st, i) => <span key={st.id} className={`h-1 flex-1 rounded-full transition-colors duration-200 ${i <= step ? 'bg-foreground' : 'bg-border'}`} />)}
          </div>
        </div>
      )}
      <div className="mb-6 max-md:sr-only">
        <h1 className="text-2xl font-semibold tracking-tight mb-1">New experiment</h1>
        <p className="text-sm text-muted-foreground">
          Pick the data, configure the compressors, choose how results are combined. The summary keeps the Run button in reach.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[9rem_minmax(0,1fr)_18rem]">
        <nav aria-label="Steps" className="hidden lg:block sticky top-20 self-start">
          <ol className="space-y-1 text-sm">
            {steps.map((step, i) => (
              <li key={step.id}>
                <a
                  href={`#${step.id}`}
                  onClick={(e) => { e.preventDefault(); document.getElementById(step.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-secondary"
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${step.done ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground'}`}>
                    {step.done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                  </span>
                  {step.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={`min-w-0 ${phone ? 'wizard' : ''}`}>
        {/* Step 1: data */}
        <section id="step-data" aria-label="Data" className="mb-10 scroll-mt-20" hidden={phone && step !== 0}>
          <h2 className="text-base font-medium text-foreground mb-3 max-md:sr-only">1 · Data</h2>
          <div className="mb-6">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
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
              placeholder="My experiment"
              className="max-w-md"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <span className="text-sm font-medium text-foreground">Source</span>
            <div role="tablist" aria-label="Data source" className="inline-flex rounded-md border border-border p-0.5 text-xs">
              {(['files', 'dataset'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={source === s}
                  disabled={loading}
                  onClick={() => { setSource(s); setError('') }}
                  className={`px-3 py-1 rounded ${source === s ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {s === 'files' ? 'Upload files' : 'Standard dataset'}
                </button>
              ))}
            </div>
          </div>
          {source === 'dataset' ? (
            <DatasetPanel
              catalog={datasetCatalog}
              selection={datasetSelection}
              onChange={(next) => {
                if (!name && next.dataset) setName(next.dataset)
                setDatasetSelection(next)
              }}
              disabled={loading}
            />
          ) : (
          <div className="space-y-3">
            {/* File format info */}
            <div className="text-xs text-muted-foreground bg-secondary/30 rounded-lg p-3 space-y-1">
              <p><strong>Accepted formats:</strong> <code>.bin</code> (binary integer sequences), <code>.csv</code> (one column per sequence), <code>.zip</code> / <code>.tar</code> (multiple <code>.bin</code> inside).</p>
              <p><strong>Binary header:</strong> 16-byte <code>(N + decimals + N×int64)</code> or 8-byte <code>(N + N×int64)</code>, recognised from the header N.</p>
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
                  {phone ? 'Tap to choose files' : 'Drag & drop your file(s) here'}
                </p>
                <p className="text-xs text-muted-foreground">
                  .bin, .csv, .zip, or .tar{maxFileSizeMb > 0 ? ` — max ${maxFileSizeMb} MB each` : ''}
                </p>
                <input
                  type="file"
                  className="hidden"
                  accept={ACCEPTED_EXTENSIONS.join(',')}
                  multiple
                  onChange={handleFileInput}
                />
              </label>
            )}
          </div>
          </div>
          )}
        </div>
        </section>

        {/* Step 2: compressors */}
        <section id="step-compressors" aria-label="Compressors" className="mb-10 scroll-mt-20" hidden={phone && step !== 1}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-base font-medium text-foreground max-md:sr-only">2 · Compressors</h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-expanded={loadOpen}
                aria-controls="load-panel"
                className="text-xs rounded-md border border-border px-2 py-1 hover:bg-secondary"
                onClick={() => setLoadOpen((v) => !v)}
              >
                Load preset or recent… {presets.length + history.length > 0 ? `(${presets.length + history.length})` : ''}
              </button>
              <span className="text-xs text-muted-foreground">
                {instances.length}/{MAX_INSTANCES_PER_BENCHMARK} instances
              </span>
            </div>
          </div>
          {loadOpen && (
            <div id="load-panel" className="mb-4">
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
          )}

          {emulatedSelected.length > 0 && (
            <div
              data-testid="emulation-warning"
              className="flex items-start gap-2 mb-4 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
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
            {!phone && pickerPane}
            {/* Configured instances */}
            <div className="border border-border rounded-lg">
              <div className="p-3 border-b border-border">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">Configured Instances</h3>
                  {instances.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => { if (confirm('Remove every configured instance?')) { setInstances([]); setExpandedInstance(null) } }}
                    >
                      Remove all
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Every instance is benchmarked separately; identical configurations are rejected.
                </p>
              </div>
              <div className="max-h-[28rem] overflow-y-auto p-3 space-y-2">
                {instances.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">
                    No compressors configured yet. {phone ? 'Tap Add compressor below.' : 'Add one from the list on the left.'}
                  </p>
                ) : (
                  instances.map((inst, index) => {
                    const schema = compressors[inst.name] || {}
                    const rawLabel = buildLabel(inst.name, schema, inst.options)
                    const label = renameCompressor(rawLabel)
                    const expanded = expandedInstance === index
                    const emulated = isEmulated(packagePlatforms[inst.name], hostPlatform)
                    return (
                      <div key={index} className="border border-border rounded-md">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          <button
                            type="button"
                            className="flex-1 text-left min-w-0"
                            aria-label={`Configure ${label}`}
                            onClick={() => setExpandedInstance(expanded ? null : index)}
                          >
                            <span className="flex items-center gap-1.5 min-w-0">
                              <CompressorSwatch name={rawLabel} color={instanceStyles.get(rawLabel)?.color} shape={instanceStyles.get(rawLabel)?.shape} />
                              <span className={`font-mono text-sm truncate ${expanded ? 'font-semibold' : ''}`}>{label}</span>
                              {emulated && (
                                <span
                                  data-testid={`emulated-${inst.name}`}
                                  className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
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

          {phone && (
            <>
              <Button type="button" variant="outline" className="mt-3 w-full" onClick={() => setPickerOpen(true)}><Plus className="mr-1 h-4 w-4" />Add compressor</Button>
              <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Add compressor" className="h-[90dvh]"
                footer={<Button className="w-full" onClick={() => setPickerOpen(false)}>Done · {instances.length} configured</Button>}>
                {pickerPane}
              </Sheet>
            </>
          )}
          {validationError && (
            <p className={`text-xs mt-2 ${instances.length === 0 ? 'text-muted-foreground' : 'text-destructive'}`}>{validationError}</p>
          )}
          <div className="mt-3 max-w-xl">
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
            {presetError && <p className="text-xs text-destructive mt-1">{presetError}</p>}
          </div>
        </section>

        {/* Step 3: run settings */}
        <section id="step-settings" aria-label="Run settings" className="mb-10 scroll-mt-20" hidden={phone && step !== 2}>
          <h2 className="text-base font-medium text-foreground mb-3 max-md:sr-only">3 · Run settings</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="aggregation">Aggregate results over inputs</Label>
              <select
                id="aggregation"
                className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-2 text-sm"
                value={aggregation}
                disabled={loading}
                onChange={(e) => setAggregation(e.target.value as Aggregation)}
              >
                {(Object.keys(AGGREGATION_INFO) as Aggregation[]).map((a) => (
                  <option key={a} value={a}>{AGGREGATION_INFO[a].label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{AGGREGATION_INFO[aggregation].help}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="measure-memory">Memory measurement</Label>
              <div className="flex items-center gap-2">
                <Switch id="measure-memory" checked={measureMemory} onCheckedChange={setMeasureMemory} disabled={loading} />
                <span className="text-sm">{measureMemory ? 'Valgrind Massif on' : 'Off'}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Peak-memory profiling of built-in compressors. It runs every compressor again under Valgrind
                (much slower); turn it off for large chunk sweeps.
              </p>
            </div>
          </div>
        </section>

        </div>

        <aside aria-label="Summary" className="sticky bottom-0 max-md:fixed max-md:inset-x-0 max-md:mx-0 max-md:pb-[max(1rem,env(safe-area-inset-bottom))] lg:bottom-auto lg:top-20 self-end lg:self-start z-10 -mx-4 lg:mx-0 border-t lg:border border-border bg-background lg:rounded-md p-4 space-y-3">
          <h2 className="text-sm font-medium hidden lg:block">Summary</h2>
          <dl data-testid="run-summary" className="hidden lg:grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {summaryRows.map(([k, v]) => (
              <Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-mono truncate" title={v}>{v}</dd></Fragment>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground lg:hidden truncate">{summaryRows.map(([, v]) => v).filter((v) => v !== '—').join(' · ')}</p>
        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 mb-4 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Submit */}
        <div className="flex flex-col gap-2">
          {phone && step < steps.length - 1 ? (
            <>
              <Button type="button" onClick={nextStep} className="w-full">Next: {steps[step + 1].label}</Button>
              {stepHint && <p role="alert" className="text-xs text-destructive">{stepHint}</p>}
            </>
          ) : (
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit || loading} className="w-full">
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {uploadPhase === 'processing' ? (source === 'dataset' ? 'Preparing inputs…' : 'Processing…') : 'Uploading…'}
              </span>
            ) : (
              'Run Benchmark'
            )}
          </Button>
          )}
          {!canSubmit && !loading && !(phone && step < steps.length - 1) && (
            <p data-testid="submit-hint" className="text-xs text-muted-foreground">
              {!name && 'Enter a name'}
              {name && !inputReady && (source === 'files' ? ' · Select a file' : ` · ${datasetError}`)}
              {name && inputReady && instances.length === 0 && ' · Configure at least one compressor'}
              {name && inputReady && instances.length > 0 && validationError && ` · ${validationError}`}
            </p>
          )}
        </div>
        </aside>
      </div>
    </div>
  )
}
