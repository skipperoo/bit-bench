// Installable-app plumbing: service worker, install prompt, no pinch zoom on iOS.

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null

export function initPwa(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
  }
  // iOS Safari ignores user-scalable=no; cancelling its gesture events stops pinch zoom.
  document.addEventListener('gesturestart', (e) => e.preventDefault())
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
  })
  window.addEventListener('appinstalled', () => { deferred = null })
}

export function isStandalone(): boolean {
  return (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** iPhone/iPad Safari, which installs only through Share → Add to Home Screen. */
export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function canPromptInstall(): boolean {
  return deferred !== null
}

/** Shows the browser's install prompt (Chrome, Edge, Android); true when accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const event = deferred
  deferred = null
  await event.prompt()
  return (await event.userChoice).outcome === 'accepted'
}
