import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** Says why nothing loads while the device is offline (the installed app still opens). */
export function OfflineNotice() {
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
  if (online) return null
  return (
    <p role="status" className="mb-4 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
      You're offline. Results and runs need a connection; this page updates when you're back online.
    </p>
  )
}
