import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { X } from 'lucide-react'
import { apiFetch, apiUpload } from '@/lib/api'
import { computeMD5 } from '@/lib/md5'
import { shouldUseSlider } from '@/lib/options'
import type { CompressorRegistry, CompressorOption } from '@/types'

export default function UploadPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
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

  const handleFileChange = useCallback(async (f: File | null) => {
    setFile(f)
    setDuplicate(false)
    if (!f) return
    try {
      const md5 = await computeMD5(f)
      const checksums = await apiFetch<{ checksum: string }[]>('/benchmarks/checksums')
      const found = checksums.some((c) => c.checksum === md5)
      setDuplicate(found)
      if (found) setError('This file has already been benchmarked (duplicate checksum)')
      else setError('')
    } catch {
      // proceed without duplicate check
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFileChange(f)
  }, [handleFileChange])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null
    if (f) handleFileChange(f)
  }, [handleFileChange])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !file || duplicate) return
    setLoading(true)
    setError('')
    try {
      const selected = Object.entries(selectedCompressors)
        .filter(([, v]) => v)
        .map(([k]) => k)
      const formData = new FormData()
      formData.append('name', name)
      formData.append('file', file)
      formData.append('compressors', JSON.stringify(
        Object.fromEntries(selected.map((c) => [c, compressorOptions[c] || {}]))
      ))
      const res = await apiUpload<{ id: string }>('/benchmarks', formData)
      navigate(`/results/${res.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  const canSubmit = name && file && Object.values(selectedCompressors).some(Boolean) && !duplicate

  function renderOptionField(name: string, key: string, opt: CompressorOption) {
    const value = compressorOptions[name]?.[key]

    if (opt.type === 'boolean') {
      return (
        <Switch
          checked={(value as boolean) || false}
          onCheckedChange={(v) =>
            setCompressorOptions((prev) => ({ ...prev, [name]: { ...prev[name], [key]: v } }))
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
            setCompressorOptions((prev) => ({ ...prev, [name]: { ...prev[name], [key]: e.target.value } }))
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
                setCompressorOptions((prev) => ({ ...prev, [name]: { ...prev[name], [key]: v } }))
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
            setCompressorOptions((prev) => ({ ...prev, [name]: { ...prev[name], [key]: Number(e.target.value) } }))
          }
        />
      )
    }

    return null
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New Benchmark</h1>
        <p className="text-muted-foreground mt-1">
          Upload an integer sequence file (.bin, .csv, .zip, .tar) and select compressors to test.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="name">Benchmark Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My benchmark"
            required
          />
        </div>

        <div className="space-y-2">
          <Label>File</Label>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              dragOver ? 'border-primary bg-primary/5' : duplicate ? 'border-destructive bg-destructive/5' : 'border-border'
            }`}
          >
            {file ? (
              <div className="space-y-1 relative">
                <p className="text-sm">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
                <button
                  type="button"
                  onClick={() => { setFile(null); setDuplicate(false); setError('') }}
                  className="absolute -top-1 -right-1 p-1 rounded-full bg-muted hover:bg-muted-foreground/20 transition-colors"
                  title="Remove file"
                >
                  <X className="w-4 h-4" />
                </button>
                {duplicate && (
                  <p className="text-xs text-destructive">Duplicate file — already benchmarked</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Drag & drop a file here, or{' '}
                <label className="text-primary cursor-pointer underline">
                  browse
                  <input
                    type="file"
                    className="hidden"
                    accept=".bin,.csv,.zip,.tar"
                    onChange={handleFileInput}
                  />
                </label>
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Compressors</h2>
          {Object.keys(compressors).length === 0 && (
            <p className="text-sm text-muted-foreground">Loading compressors...</p>
          )}
          <Accordion
            type="multiple"
            value={compressorsOpen}
            onValueChange={setCompressorsOpen}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          >
            {Object.entries(compressors).map(([name, options]) => (
              <AccordionItem key={name} value={name} className="border rounded-lg">
                <AccordionTrigger className="px-3 py-2 hover:no-underline hover:bg-secondary/30 rounded-t-lg data-[state=open]:rounded-t-lg data-[state=open]:rounded-b-none">
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={selectedCompressors[name] || false}
                      onCheckedChange={(v) =>
                        setSelectedCompressors((prev) => ({ ...prev, [name]: v }))
                      }
                    />
                  </div>
                  <span className={`font-mono text-sm ml-2 ${selectedCompressors[name] ? 'font-semibold' : 'text-muted-foreground'}`}>
                    {name}
                  </span>
                </AccordionTrigger>
                {Object.keys(options).length > 0 && (
                  <AccordionContent className="px-3 pb-3">
                    <div className="space-y-2 pt-2">
                      {Object.entries(options).map(([key, opt]) => (
                        <div key={key} className="flex items-center gap-2">
                          <Label className="text-xs w-20 shrink-0">{key}</Label>
                          {renderOptionField(name, key, opt)}
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                )}
                {Object.keys(options).length === 0 && (
                  <AccordionContent className="px-3 pb-2">
                    <p className="text-xs text-muted-foreground">No configuration options</p>
                  </AccordionContent>
                )}
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <Button type="submit" disabled={!canSubmit || loading} className="w-full">
          {loading ? 'Running Benchmark...' : 'Run Benchmark'}
        </Button>
      </form>
    </div>
  )
}
