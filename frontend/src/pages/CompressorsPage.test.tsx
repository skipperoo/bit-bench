import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CompressorsPage from './CompressorsPage'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { CompressorPackage } from '@/types'

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiUpload: vi.fn(),
}))

const mockedFetch = vi.mocked(apiFetch)

function tokenFor(payload: Record<string, unknown>): string {
  return `x.${btoa(JSON.stringify(payload))}.y`
}

function setRole(role: string) {
  useAuthStore.setState({
    token: tokenFor({ sub: 'u1', role, group_id: 'g1', exp: Math.floor(Date.now() / 1000) + 3600 }),
  })
}

function packageFixture(overrides: Partial<CompressorPackage> = {}): CompressorPackage {
  return {
    id: 'p1',
    owner_id: 'owner-2',
    group_id: 'g1',
    name: 'my_codec',
    version: '1.0.0',
    description: 'test package',
    language: 'cpp',
    entrypoint: './codec',
    workers: 2,
    spec: {},
    status: 'ready',
    archive_checksum: 'x',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ token: null, user: null })
})

describe('CompressorsPage', () => {
  it('renders packages and disables upload for students', async () => {
    setRole('student')
    mockedFetch.mockResolvedValue([packageFixture()])

    render(<CompressorsPage />)

    expect(await screen.findByText('my_codec')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload package/i })).toBeDisabled()
    expect(screen.getByText(/cannot upload new packages/i)).toBeInTheDocument()
    expect(screen.queryByTitle('Delete package')).not.toBeInTheDocument()
  })

  it('enables upload and delete for the owner', async () => {
    setRole('phd')
    mockedFetch.mockResolvedValue([packageFixture({ owner_id: 'u1' })])

    render(<CompressorsPage />)

    expect(await screen.findByText('my_codec')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload package/i })).toBeEnabled()
    expect(screen.getByTitle('Delete package')).toBeInTheDocument()
  })

  it('shows a build log toggle for failed packages', async () => {
    setRole('professor')
    mockedFetch.mockResolvedValue([
      packageFixture({ status: 'failed', error: 'build failed', build_log: 'gcc: error: boom' }),
    ])

    render(<CompressorsPage />)

    const toggle = await screen.findByRole('button', { name: /build log/i })
    await userEvent.click(toggle)

    await waitFor(() => {
      expect(screen.getByText(/gcc: error: boom/)).toBeInTheDocument()
    })
  })
})
