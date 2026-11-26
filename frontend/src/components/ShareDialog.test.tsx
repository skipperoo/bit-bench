import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShareDialog from './ShareDialog'
import { apiFetch } from '@/lib/api'
import type { Share } from '@/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
const mocked = vi.mocked(apiFetch)

const share = (extra: Partial<Share> = {}): Share => ({
  id: 's1', kind: 'private', token: 'T0k3n_private', expires_at: null, revoked_at: null,
  created_at: '2026-11-26T10:00:00Z', benchmark_ids: ['a', 'b'], recipients: ['anna@lab.org'], ...extra,
})

let listed: Share[] = []
beforeEach(() => {
  vi.clearAllMocks()
  listed = []
  mocked.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/shares?')) return { shares: listed } as never
    if (path === '/shares' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      if (body.emails.includes('nobody@lab.org')) throw new Error('not BitBench accounts: nobody@lab.org')
      return share({ kind: body.kind, token: body.kind === 'public' ? 'p-stable' : 'T0k3n_private' }) as never
    }
    if (path === '/shares/s1' && init?.method === 'PATCH') return share({ revoked_at: '2026-11-26T11:00:00Z' }) as never
    return {} as never
  })
})

const renderDialog = () => render(<ShareDialog benchmarkIds={['a', 'b']} title="Sweep" tab="pareto" onClose={() => {}} />)

describe('ShareDialog', () => {
  it('creates a private link for the listed accounts', async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText(/BitBench accounts/), 'anna@lab.org{enter}')
    expect(screen.getByRole('button', { name: 'Remove anna@lab.org' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }))

    const post = mocked.mock.calls.find(([p, i]) => p === '/shares' && i?.method === 'POST')!
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      kind: 'private', benchmark_ids: ['a', 'b'], emails: ['anna@lab.org'], origin: window.location.origin,
    })
    expect(within(await screen.findByTestId('share-created')).getByLabelText('Share link'))
      .toHaveValue(`${window.location.origin}/s/T0k3n_private?tab=pareto`)
  })

  it('shows which emails are not accounts', async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText(/BitBench accounts/), 'nobody@lab.org{enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not BitBench accounts: nobody@lab.org')
  })

  it('creates a public link with a warning', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'Public' }))
    expect(screen.getByRole('note')).toHaveTextContent('No login needed')
    await userEvent.click(screen.getByRole('button', { name: 'Never' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create public link' }))
    const post = mocked.mock.calls.find(([p, i]) => p === '/shares' && i?.method === 'POST')!
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ kind: 'public', emails: [], expires_at: null })
  })

  it('revokes an existing link', async () => {
    listed = [share()]
    renderDialog()
    const row = await screen.findByTestId('share-row')
    expect(row).toHaveTextContent('For anna@lab.org')
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    const patch = mocked.mock.calls.find(([p, i]) => p === '/shares/s1' && i?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({ revoked: true })
    expect(await screen.findByText('Revoked')).toBeInTheDocument()
    expect(within(screen.getByTestId('share-row')).getByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('copies with execCommand when the Clipboard API is missing (plain HTTP)', async () => {
    listed = [share()]
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    renderDialog()
    const row = await screen.findByTestId('share-row')
    await userEvent.click(within(row).getByRole('button', { name: 'Copy' }))
    expect(exec).toHaveBeenCalledWith('copy')
    expect(within(row).getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true })
  })
})
