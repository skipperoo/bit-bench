import { create } from 'zustand'

interface TokenPayload {
  role?: string
  exp?: number
}

function decodePayload(token: string): TokenPayload | null {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}

interface AuthState {
  token: string | null
  setToken: (token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
  getRole: () => string | null
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('admin_token'),
  setToken: (token: string) => {
    localStorage.setItem('admin_token', token)
    set({ token })
  },
  logout: () => {
    localStorage.removeItem('admin_token')
    set({ token: null })
  },
  isAuthenticated: () => {
    const { token } = get()
    if (!token) return false
    const payload = decodePayload(token)
    if (!payload?.exp) return false
    const isStaff = payload.role === 'admin' || payload.role === 'professor'
    return isStaff && payload.exp * 1000 > Date.now()
  },
  getRole: () => {
    const { token } = get()
    if (!token) return null
    return decodePayload(token)?.role ?? null
  },
}))
