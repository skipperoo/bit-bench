import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import SharedView from './SharedView'
import { apiFetch } from '@/lib/api'
import { useChartStyles } from '@/stores/chart-styles-store'
import type { Benchmark, BenchmarkResult, SharedPage } from '@/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const bench = (id: string, name: string): Benchmark => ({
  id, name, user_id: '00000000-0000-0000-0000-000000000000', original_filename: 'x', file_size: 1, file_checksum: '',
  file_ext: 'bin', status: 'ready', created_at: '2026-11-12T10:00:00Z', compressors: [],
})
const res = (compressor: string, ratio: number): BenchmarkResult => ({
  id: compressor, benchmark_id: 'b', compressor, dataset: 'd', compression_ratio: ratio,
  compression_throughput_mbs: 10, decompression_throughput_mbs: 20, num_values: 100, compressed_bits: ratio * 6400, uncompressed_bits: 6400,
})
const page: SharedPage = {
  kind: 'private', owner_email: 'owner@lab.org', expires_at: null,
  benchmarks: [{ benchmark: bench('a', 'Run A'), results: [res('gzip', 0.3)] }, { benchmark: bench('b', 'Run B'), results: [res('gzip', 0.4)] }],
  chart_styles: { colors: { gzip: '#123456' } },
  package_colors: {},
}

function mockShared(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

function renderShared() {
  return render(
    <MemoryRouter initialEntries={['/s/tok']}>
      <Routes>
        <Route path="/s/:token" element={<SharedView />} />
        <Route path="/login" element={<p>login page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useChartStyles.getState().clear()
})

describe('SharedView', () => {
  it('shows the results read-only, with hideable benchmarks and unsaved styles', async () => {
    mockShared(200, page)
    renderShared()
    expect(await screen.findByText(/Read-only · shared by owner@lab.org/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Add a benchmark to the comparison')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove Run/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download all results/ })).toBeInTheDocument()

    // The owner's styles apply locally.
    await waitFor(() => expect(useChartStyles.getState()).toMatchObject({ local: true, colors: { gzip: '#123456' } }))

    // Hide one benchmark; the last visible one cannot be hidden.
    await userEvent.click(screen.getByRole('button', { name: 'Hide Run A' }))
    expect(screen.getByRole('button', { name: 'Show Run A' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Hide Run B' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Show Run A' }))
    expect(screen.getByRole('button', { name: 'Hide Run B' })).toBeEnabled()

    // Nothing goes through the authenticated API (no saves, no package lookups).
    expect(apiFetch).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('/api/v1/shared/tok', expect.anything())
  })

  it('sends logged-out viewers of a private link to the login page', async () => {
    mockShared(401, { error: 'log in to open this link' })
    renderShared()
    expect(await screen.findByText('login page')).toBeInTheDocument()
  })

  it('explains a dead link', async () => {
    mockShared(404, { error: 'link not available' })
    renderShared()
    expect(await screen.findByText(/This link is not available/)).toBeInTheDocument()
  })
})
