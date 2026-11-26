import { useAuthStore } from '@/stores/auth-store'

/** The link to a share on the host the app is served from (no server-side URL config). */
export function shareUrl(token: string, tab?: string): string {
  return `${window.location.origin}/s/${token}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`
}

export const EXPIRY_PRESETS = [
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: 'Never', days: 0 },
] as const

/** ISO expiry `days` from now; null for never. */
export function expiryIn(days: number, now = Date.now()): string | null {
  return days > 0 ? new Date(now + days * 86_400_000).toISOString() : null
}

/** Expiry at the end of a picked yyyy-mm-dd day (local time). */
export function expiryOnDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return new Date(`${date}T23:59:59`).toISOString()
}

export function shareState(s: { revoked_at: string | null; expires_at: string | null }, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (s.revoked_at) return 'revoked'
  if (s.expires_at && new Date(s.expires_at).getTime() <= now) return 'expired'
  return 'active'
}

export class SharedLinkError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Fetches a shared-link endpoint with the login token when there is one. Unlike
 * apiFetch it never logs out: a 401 only means "log in to open this link".
 */
export async function sharedFetch<T>(path: string): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/api/v1/shared/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new SharedLinkError(res.status, err.error || res.statusText)
  }
  return res.json()
}
