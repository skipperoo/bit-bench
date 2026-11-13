import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import ExperimentsPage from './ExperimentsPage'
import { apiFetch } from '@/lib/api'
import type { Benchmark } from '@/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
const mockedFetch = vi.mocked(apiFetch)

function bench(id: string, name: string, extra: Partial<Benchmark> = {}): Benchmark {
  return {
    id, name, user_id: 'u', original_filename: 'wildppg', file_size: 1000, file_checksum: 'c', file_ext: 'dataset',
    status: 'ready', created_at: '2026-11-12T10:00:00Z',
    compressors: [{ name: 'gzip', options: {}, label: 'gzip' }], ...extra,
  }
}

const sweep = { kind: 'dataset' as const, dataset: 'wildppg', series: ['a'], chunk_size: 768, max_chunks: 10, transform: 'std' as const, inputs: 10 }

beforeEach(() => {
  vi.clearAllMocks()
  mockedFetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/datasets')) return { datasets: [{ name: 'wildppg', series: [] }] } as never
    if (path.startsWith('/benchmarks?')) {
      return {
        benchmarks: [
          bench('1', 'wild · std · 768', { experiment_id: 'e1', source: sweep }),
          bench('2', 'wild · gap · 768', { experiment_id: 'e1', source: { ...sweep, transform: 'gap' }, status: 'in_progress' }),
          bench('3', 'single upload', { file_ext: 'bin', original_filename: 'x.bin' }),
        ],
      } as never
    }
    return {} as never
  })
})

function NewPageProbe() {
  return <pre data-testid="rerun-state">{JSON.stringify(useLocation().state)}</pre>
}

function renderPage(url = '/experiments') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/experiments" element={<ExperimentsPage />} />
        <Route path="/new" element={<NewPageProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ExperimentsPage', () => {
  it('groups benchmarks of one experiment and expands them', async () => {
    renderPage()
    expect(await screen.findByRole('link', { name: 'wild' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'single upload' })).toBeInTheDocument()
    // The group shows the aggregate (active) status.
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: 'wild · std · 768' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Expand wild' }))
    expect(screen.getByRole('link', { name: 'wild · std · 768' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'wild' })).toHaveAttribute('href', '/experiments/view?ids=1,2')
  })

  it('selects a whole experiment and offers bulk actions', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select wild' }))
    const bar = screen.getByRole('toolbar', { name: 'Selection' })
    expect(bar).toHaveTextContent('2 selected')
    expect(screen.getByRole('button', { name: /Compare/ })).toBeEnabled()
    // A whole dataset experiment re-runs with all of its chunk sizes and transforms.
    await userEvent.click(screen.getByRole('button', { name: /Re-run/ }))
    const state = JSON.parse(screen.getByTestId('rerun-state').textContent!)
    expect(state.rerun.name).toBe('wild')
    expect(state.rerun.source.transforms).toEqual(['std', 'gap'])
    expect(state.rerun.source.chunk_sizes).toEqual([768])
  })

  it('does not re-run benchmarks of different experiments together', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select wild' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select single upload' }))
    expect(screen.getByRole('button', { name: /Re-run/ })).toBeDisabled()
  })

  it('selects everything from the header checkbox', async () => {
    renderPage()
    const all = await screen.findByRole('checkbox', { name: 'Select all' })
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select single upload' }))
    expect((all as HTMLInputElement).indeterminate).toBe(true)
    await userEvent.click(all)
    expect(screen.getByRole('toolbar', { name: 'Selection' })).toHaveTextContent('3 selected')
    await userEvent.click(all)
    expect(screen.queryByRole('toolbar', { name: 'Selection' })).not.toBeInTheDocument()
  })

  it('selects a range with shift-click over the visible rows', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Expand wild' }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Select wild · gap · 768' }))
    await user.keyboard('{Shift>}')
    await user.click(screen.getByRole('checkbox', { name: 'Select single upload' }))
    await user.keyboard('{/Shift}')
    // gap row + single upload; the std row above the anchor stays unselected.
    expect(screen.getByRole('toolbar', { name: 'Selection' })).toHaveTextContent('2 selected')
    expect(screen.getByRole('checkbox', { name: 'Select wild · std · 768' })).not.toBeChecked()
    // Shift-click upwards extends the same way.
    await user.keyboard('{Shift>}')
    await user.click(screen.getByRole('checkbox', { name: 'Select wild' }))
    await user.keyboard('{/Shift}')
    expect(screen.getByRole('toolbar', { name: 'Selection' })).toHaveTextContent('3 selected')
  })

  it('sends the URL filters to the API', async () => {
    renderPage('/experiments?status=ready&dataset=wildppg&compressor=gzip')
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/benchmarks\?/)))
    const call = mockedFetch.mock.calls.map((c) => c[0] as string).find((p) => p.startsWith('/benchmarks?'))!
    const q = new URLSearchParams(call.split('?')[1])
    expect([q.get('status'), q.get('dataset'), q.get('compressor')]).toEqual(['ready', 'wildppg', 'gzip'])
    expect((screen.getByLabelText('Data source') as HTMLSelectElement).value).toBe('dataset:wildppg')
  })
})
