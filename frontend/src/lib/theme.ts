import { useEffect, useState } from 'react'

/** Colour theme: an explicit choice, or follow the operating system. */
export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'bitbench-theme'

export function storedTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** Whether a choice renders dark right now. */
export function isDark(choice: ThemeChoice, prefersDark = systemPrefersDark()): boolean {
  return choice === 'dark' || (choice === 'system' && prefersDark)
}

/** Saves the choice (per browser) and applies it to the document. */
export function applyTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // Storage blocked: the theme still applies for this page view.
  }
  document.documentElement.classList.toggle('dark', isDark(choice))
}

/** Whether the document is currently dark (follows the `dark` class on <html>). */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => setDark(el.classList.contains('dark')))
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** Whether the user asked the system for reduced motion (charts then skip their animation). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
