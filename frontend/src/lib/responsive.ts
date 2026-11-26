import { useSyncExternalStore } from 'react'

/** Phones get the mobile layout; tablets and desktops keep the desktop one (Tailwind `md`). */
export const PHONE_QUERY = '(max-width: 767px)'

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null
}

function subscribe(onChange: () => void): () => void {
  const mq = query()
  mq?.addEventListener?.('change', onChange)
  return () => mq?.removeEventListener?.('change', onChange)
}

/** Whether the viewport is phone-sized; false without matchMedia (tests, SSR). */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false, () => false)
}
