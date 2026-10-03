import { create } from 'zustand'

interface AuthState {
  token: string | null
  user: { sub: string; email: string; role: string; group_id?: string } | null
  setToken: (token: string) => void
  setUser: (user: AuthState['user']) => void
  logout: () => void
  isAuthenticated: () => boolean
  getRole: () => string | null
  getGroupID: () => string | null
  getUserID: () => string | null
}

function claimsFromToken(token: string | null): Record<string, unknown> | null {
  if (!token) return null
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  user: null,
  setToken: (token: string) => {
    localStorage.setItem('token', token)
    set({ token })
  },
  setUser: (user) => set({ user }),
  logout: () => {
    localStorage.removeItem('token')
    set({ token: null, user: null })
  },
  isAuthenticated: () => {
    const { token } = get()
    const payload = claimsFromToken(token)
    if (!payload) return false
    return Number(payload.exp) * 1000 > Date.now()
  },
  getRole: () => {
    const payload = claimsFromToken(get().token)
    return payload && typeof payload.role === 'string' ? payload.role : null
  },
  getGroupID: () => {
    const payload = claimsFromToken(get().token)
    return payload && typeof payload.group_id === 'string' && payload.group_id !== ''
      ? payload.group_id
      : null
  },
  getUserID: () => {
    const payload = claimsFromToken(get().token)
    return payload && typeof payload.sub === 'string' ? payload.sub : null
  },
}))
