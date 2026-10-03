import { useState, useEffect, useCallback, Fragment } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { apiFetch, apiUpload } from '@/lib/api'
import { canManagePackage, PACKAGE_STATUS_CLASSES, PACKAGE_STATUS_DOT, packageStatusLabel } from '@/lib/packages'
import { useAuthStore } from '@/stores/auth-store'
import { Upload, Trash2, FileArchive, Loader2 } from 'lucide-react'
import type { CompressorPackage, GroupRef } from '@/types'

export default function CompressorsPage() {
  const role = useAuthStore((s) => s.getRole)()
  const userId = useAuthStore((s) => s.getUserID)()
  const groupID = useAuthStore((s) => s.getGroupID)()
  const isAdmin = role === 'admin'
  const canUpload = role === 'admin' || role === 'professor' || role === 'phd'

  const [packages, setPackages] = useState<CompressorPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [groups, setGroups] = useState<GroupRef[]>([])
  const [groupId, setGroupId] = useState('')
  const [uploading, setUploading] = useState(false)
  const [openLog, setOpenLog] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<CompressorPackage[]>('/compressors/packages')
      setPackages(data ?? [])
    } catch {
      // keep the last known list
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!isAdmin) return
    apiFetch<GroupRef[]>('/admin/groups')
      .then((data) => setGroups(data ?? []))
      .catch(() => {})
  }, [isAdmin])

  const hasBuilding = packages.some((p) => p.status === 'building')
  useEffect(() => {
    if (!hasBuilding) return
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [hasBuilding, load])

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      if (isAdmin && groupId) form.append('group_id', groupId)
      await apiUpload('/compressors/packages', form)
      setFile(null)
      setGroupId('')
      setShowUpload(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (pkg: CompressorPackage) => {
    if (!confirm(`Delete compressor "${pkg.name}"? Results already produced keep their data.`)) return
    try {
      await apiFetch(`/compressors/packages/${pkg.id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight mb-1">Compressors</h1>
          <p className="text-sm text-muted-foreground">
            User-provided compressor packages available to your group, plus the built-in algorithms.
          </p>
        </div>
        <Button
          onClick={() => setShowUpload((v) => !v)}
          disabled={!canUpload}
          title={canUpload ? undefined : 'Students can run benchmarks but cannot upload compressors'}
        >
          <Upload className="w-4 h-4 mr-2" />
          {showUpload ? 'Cancel' : 'Upload package'}
        </Button>
      </div>

      {!canUpload && (
        <p className="text-xs text-muted-foreground mb-4">
          Students can run benchmarks with the available compressors but cannot upload new packages.
        </p>
      )}

      {error && <p className="text-sm text-destructive mb-4">{error}</p>}

      {showUpload && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Upload compressor package</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleUpload} className="space-y-4 max-w-lg">
              <div className="space-y-1.5">
                <Label htmlFor="package">Package (.zip)</Label>
                <Input
                  id="package"
                  type="file"
                  accept=".zip"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Archive root must contain <code>spec.yaml</code> and the sources. Dependencies must be
                  vendored: the build runs offline.
                </p>
              </div>
              {isAdmin && (
                <div className="space-y-1.5">
                  <Label htmlFor="group">Visible to group (optional)</Label>
                  <select
                    id="group"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                  >
                    <option value="">Admins only</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <Button type="submit" disabled={uploading || !file}>
                {uploading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {uploading ? 'Uploading...' : 'Upload and build'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : packages.length === 0 ? (
        <div className="border border-border rounded-lg p-8 text-center">
          <FileArchive className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-foreground">No compressor packages yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            {canUpload
              ? 'Upload a .zip package to make it selectable in new benchmarks.'
              : 'Packages uploaded by professors and PhDs of your group appear here.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Version</th>
                <th className="text-left p-3 font-medium">Language</th>
                <th className="text-left p-3 font-medium">Workers</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-left p-3 font-medium">Updated</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg) => (
                <Fragment key={pkg.id}>
                  <tr className="border-b border-border last:border-0 hover:bg-secondary/30">
                    <td className="p-3">
                      <p className="font-mono font-medium">{pkg.name}</p>
                      {pkg.description && (
                        <p className="text-xs text-muted-foreground max-w-sm">{pkg.description}</p>
                      )}
                    </td>
                    <td className="p-3 font-mono text-xs">{pkg.version}</td>
                    <td className="p-3 text-xs">{pkg.language || '—'}</td>
                    <td className="p-3 text-xs">{pkg.workers}</td>
                    <td className="p-3">
                      <Badge className={PACKAGE_STATUS_CLASSES[pkg.status]}>
                        {pkg.status === 'building' && (
                          <span className={`w-1.5 h-1.5 rounded-full mr-1.5 animate-pulse ${PACKAGE_STATUS_DOT[pkg.status]}`} />
                        )}
                        {packageStatusLabel(pkg.status)}
                      </Badge>
                      {pkg.status === 'failed' && pkg.error && (
                        <p className="text-xs text-destructive mt-1 max-w-xs">{pkg.error}</p>
                      )}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {new Date(pkg.updated_at).toLocaleString()}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      {pkg.status === 'failed' && pkg.build_log && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setOpenLog(openLog === pkg.id ? null : pkg.id)}
                        >
                          {openLog === pkg.id ? 'Hide log' : 'Build log'}
                        </Button>
                      )}
                      {canManagePackage(role, userId, groupID, pkg) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(pkg)}
                          title="Delete package"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                  {openLog === pkg.id && pkg.build_log && (
                    <tr className="border-b border-border last:border-0 bg-secondary/20">
                      <td colSpan={7} className="p-3">
                        <pre className="text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
                          {pkg.build_log}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
