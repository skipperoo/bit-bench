import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import type { User, Group } from '@/types'

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<string>('')
  const [editGroupId, setEditGroupId] = useState<string>('')

  const loadUsers = () => {
    setLoading(true)
    apiFetch<User[]>('/users')
      .then((data) => setUsers(data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  const loadGroups = () => {
    apiFetch<Group[]>('/groups')
      .then((data) => setGroups(data ?? []))
      .catch(() => {})
  }

  useEffect(() => { loadUsers(); loadGroups() }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, role }),
      })
      setShowForm(false)
      setEmail('')
      setPassword('')
      setRole('user')
      loadUsers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    }
  }

  const startEdit = (u: User) => {
    setEditingId(u.id)
    setEditRole(u.role)
    setEditGroupId(u.group_id || '')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditRole('')
    setEditGroupId('')
  }

  const saveEdit = async (id: string) => {
    try {
      const body: Record<string, unknown> = { role: editRole }
      if (editGroupId) body.group_id = editGroupId
      else body.group_id = null
      await apiFetch(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      cancelEdit()
      loadUsers()
    } catch {}
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this user?')) return
    try {
      await apiFetch(`/users/${id}`, { method: 'DELETE' })
      loadUsers()
    } catch {}
  }

  const handleResetPassword = async (id: string) => {
    const newPassword = prompt('New password:')
    if (!newPassword || newPassword.length < 6) {
      alert('Password must be at least 6 characters.')
      return
    }
    const confirmPassword = prompt('Confirm new password:')
    if (confirmPassword !== newPassword) {
      alert('Passwords do not match.')
      return
    }
    try {
      await apiFetch(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ reset_password: newPassword }),
      })
      loadUsers()
    } catch {}
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : 'Create User'}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">New User</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4 max-w-md">
              <div className="space-y-1">
                <Label>Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label>Password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label>Role</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
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
                <th className="text-left p-3">Email</th>
                <th className="text-left p-3">Role</th>
                <th className="text-left p-3">Group</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b last:border-0 hover:bg-neutral-50">
                  <td className="p-3">{u.email}</td>
                  <td className="p-3">
                    {editingId === u.id ? (
                      <select
                        className="h-8 rounded border border-neutral-300 px-2 text-sm"
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <Badge variant={u.role === 'admin' ? 'default' : 'outline'}>{u.role}</Badge>
                    )}
                  </td>
                  <td className="p-3">
                    {editingId === u.id ? (
                      <select
                        className="h-8 rounded border border-neutral-300 px-2 text-sm"
                        value={editGroupId}
                        onChange={(e) => setEditGroupId(e.target.value)}
                      >
                        <option value="">— None —</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-neutral-500">
                        {u.group_id ? groups.find(g => g.id === u.group_id)?.name || u.group_id : '—'}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    {editingId === u.id ? (
                      <>
                        <Button variant="default" size="sm" onClick={() => saveEdit(u.id)}>Save</Button>
                        <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" onClick={() => startEdit(u)}>Edit</Button>
                        <Button variant="outline" size="sm" onClick={() => handleResetPassword(u.id)}>Password</Button>
                        <Button variant="destructive" size="sm" onClick={() => handleDelete(u.id)}>Delete</Button>
                      </>
                    )}
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
