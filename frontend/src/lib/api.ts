import { useAuthStore } from '@/stores/auth-store'

const API_BASE = '/api/v1'

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = useAuthStore.getState().token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (options?.body instanceof FormData) {
    delete headers['Content-Type']
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  })
  if (res.status === 401) {
    useAuthStore.getState().logout()
    window.location.href = '/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  if (res.status === 204) return undefined as T
  if (res.status === 200 || res.status === 201) {
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text)
  }
  return res.json()
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const token = useAuthStore.getState().token
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (res.status === 401) {
    useAuthStore.getState().logout()
    window.location.href = '/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  if (res.status === 200 || res.status === 201) {
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text)
  }
  return res.json()
}

export interface UploadProgress {
  /** Bytes handed to the socket so far. */
  loaded: number
  /** Total request body size, or 0 when the browser cannot compute it. */
  total: number
}

/**
 * Uploads a multipart body with progress reporting. `fetch` cannot observe
 * request upload progress, so this uses XMLHttpRequest; the request semantics
 * (auth, error handling) match `apiUpload`.
 */
export function apiUploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const token = useAuthStore.getState().token
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}${path}`)
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }

    xhr.upload.onprogress = (event) => {
      onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0 })
    }

    xhr.onload = () => {
      if (xhr.status === 401) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
        reject(new Error('unauthorized'))
        return
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (xhr.status === 204 || !xhr.responseText) {
          resolve(undefined as T)
          return
        }
        try {
          resolve(JSON.parse(xhr.responseText) as T)
        } catch {
          resolve(undefined as T)
        }
        return
      }
      let message = xhr.statusText
      try {
        message = JSON.parse(xhr.responseText).error || message
      } catch {
        // keep the status text
      }
      reject(new Error(message))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    xhr.send(formData)
  })
}
