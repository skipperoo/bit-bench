import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import type { Group, User } from '@/types'

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [priority, setPriority] = useState(0)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPriority, setEditPriority] = useState(0)

  const loadData = async () => {
    setLoading(true)
    try {
      const [g, u] = await Promise.all([
        apiFetch<Group[]>('/groups'),
        apiFetch<User[]>('/users'),
      ])
      setGroups(g ?? [])
      setUsers(u ?? [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

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
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group')
    }
  }

  const startEdit = (g: Group) => {
    setEditingId(g.id)
    setEditPriority(g.priority)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditPriority(0)
  }

  const saveEdit = async (id: string) => {
    try {
      await apiFetch(`/groups/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ priority: editPriority }),
      })
      setEditingId(null)
      await loadData()
    } catch {}
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this group? Users will lose their group assignment.')) return
    try {
      await apiFetch(`/groups/${id}`, { method: 'DELETE' })
      loadData()
    } catch {}
  }

  const usersInGroup = (groupId: string): User[] =>
    users.filter((u) => u.group_id === groupId)

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
                <th className="text-left p-3">Users in Group</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const members = usersInGroup(g.id)
                return (
                  <tr key={g.id} className="border-b last:border-0 hover:bg-neutral-50">
                    <td className="p-3 font-medium">{g.name}</td>
                    <td className="p-3">
                      {editingId === g.id ? (
                        <Input
                          type="number"
                          className="w-20 h-8"
                          value={editPriority}
                          onChange={(e) => setEditPriority(Number(e.target.value))}
                        />
                      ) : (
                        <span>{g.priority}</span>
                      )}
                    </td>
                    <td className="p-3">
                      {members.length === 0 ? (
                        <span className="text-neutral-400 text-xs">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {members.slice(0, 10).map((u) => (
                            <Badge key={u.id} variant="outline" className="text-xs">{u.email}</Badge>
                          ))}
                          {members.length > 10 && (
                            <span className="text-xs text-neutral-400">+{members.length - 10} more</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-right space-x-2">
                      {editingId === g.id ? (
                        <>
                          <Button variant="default" size="sm" onClick={() => saveEdit(g.id)}>Save</Button>
                          <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>
                        </>
                      ) : (
                        <>
                          <Button variant="outline" size="sm" onClick={() => startEdit(g)}>Edit</Button>
                          <Button variant="destructive" size="sm" onClick={() => handleDelete(g.id)}>Delete</Button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
