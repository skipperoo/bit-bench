import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import DatasetsPage from './DatasetsPage'
import BuiltinCatalogue from '@/components/BuiltinCatalogue'
import { apiFetch } from '@/lib/api'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
const mockedFetch = vi.mocked(apiFetch)

function NewProbe() {
  const location = useLocation()
  return <p>new experiment for {(location.state as { dataset?: string })?.dataset}</p>
}

beforeEach(() => vi.clearAllMocks())

describe('DatasetsPage', () => {
  it('lists series with range, chunk counts and starts a benchmark', async () => {
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === '/datasets') {
        return { datasets: [{ name: 'finance', description: 'Daily closes', series: [
          { name: 'NVDA', values: 10_000, decimals: 2, size_bytes: 80_016 },
          { name: 'BAD', values: 0, decimals: 0, size_bytes: 3, error: 'invalid .bin file' },
        ] }] } as never
      }
      if (path.includes('/preview')) return { values: 10_000, decimals: 2, min: 4812, max: 5030, mean: 4900, head: 10_000, sparkline: [[4812, 4900], [4850, 5030]] } as never
      return {} as never
    })
    render(
      <MemoryRouter initialEntries={['/datasets']}>
        <Routes>
          <Route path="/datasets" element={<DatasetsPage />} />
          <Route path="/new" element={<NewProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    const card = await screen.findByRole('region', { name: 'Dataset finance' })
    expect(within(card).getByText('Daily closes')).toBeInTheDocument()
    expect(await within(card).findByText('48.12 … 50.30')).toBeInTheDocument()
    expect(within(card).getByText(/768:13/)).toBeInTheDocument()
    expect(within(card).getByText('invalid .bin file')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: /Benchmark this dataset/ }))
    expect(screen.getByText('new experiment for finance')).toBeInTheDocument()
  })

  it('explains how to add datasets when none are mounted', async () => {
    mockedFetch.mockResolvedValue({ datasets: [] } as never)
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>)
    expect(await screen.findByText(/No standardized datasets yet/)).toBeInTheDocument()
  })
})

describe('BuiltinCatalogue', () => {
  it('groups built-ins by family and flags informational options', async () => {
    mockedFetch.mockResolvedValue({
      gzip: { level: { type: 'number', min: 1, max: 9, default: 6 } },
      gorilla: {},
      dac: { block: { type: 'number', min: 1, max: 4, default: 2 } },
      my_codec: {},
    } as never)
    render(<BuiltinCatalogue />)
    const dict = await screen.findByRole('region', { name: 'Dictionary-based' })
    expect(within(dict).getByText(/1–9, default 6/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'DAC' })).getByText('(informational)')).toBeInTheDocument()
    expect(screen.queryByText('my_codec')).not.toBeInTheDocument()
  })
})
