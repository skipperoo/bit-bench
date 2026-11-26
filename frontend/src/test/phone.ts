import { vi } from 'vitest'

/** Makes matchMedia report a phone (or not) for useIsPhone. */
export function setPhone(phone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query.includes('max-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
