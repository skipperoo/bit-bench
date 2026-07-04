import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import type { Group } from '@/types'

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [priority, setPriority] = useState(0)
  const [error, setError] = useState('')

  const loadGroups = () => {
    setLoading(true)
    apiFetch<Group[]>('/groups')
      .then((data) => setGroups(data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadGroups() }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await apiFetch('/groups', {
        method: 'POST',
        body: JSON.stringify({ name, priority }),
      })
      setShowForm(false)
      setName('')
      setPriority(0)
      loadGroups()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group')
    }
  }

  const handleUpdatePriority = async (id: string, newPriority: number) => {
    try {
      await apiFetch(`/groups/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ priority: newPriority }),
      })
      loadGroups()
    } catch {}
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this group? Users will lose their group assignment.')) return
    try {
      await apiFetch(`/groups/${id}`, { method: 'DELETE' })
      loadGroups()
    } catch {}
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Groups</h1>
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : 'Create Group'}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">New Group</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4 max-w-md">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label>Priority (higher = sooner)</Label>
                <Input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit">Create</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-neutral-500">Loading...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm bg-white rounded-lg border">
            <thead>
              <tr className="border-b bg-neutral-50">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Priority</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className="border-b last:border-0 hover:bg-neutral-50">
                  <td className="p-3 font-medium">{g.name}</td>
                  <td className="p-3">
                    <input
                      type="number"
                      className="w-20 h-8 rounded border border-neutral-300 px-2 text-sm"
                      value={g.priority}
                      onChange={(e) => handleUpdatePriority(g.id, Number(e.target.value))}
                    />
                  </td>
                  <td className="p-3 text-right">
                    <Button variant="destructive" size="sm" onClick={() => handleDelete(g.id)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
