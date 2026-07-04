import { create } from 'zustand'

interface AuthState {
  token: string | null
  setToken: (token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
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
    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      return payload.role === 'admin' && payload.exp * 1000 > Date.now()
    } catch {
      return false
    }
  },
}))
