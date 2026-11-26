import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ExperimentView from './ExperimentView'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { setPhone } from '@/test/phone'
import type { Benchmark, BenchmarkResult, DatasetSource } from '@/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
const mockedFetch = vi.mocked(apiFetch)

const source = (chunk: number, transform: DatasetSource['transform'] = 'std'): DatasetSource =>
  ({ kind: 'dataset', dataset: 'wildppg', series: ['acc'], chunk_size: chunk, max_chunks: 10, transform, inputs: 10 })

function bench(id: string, name: string, extra: Partial<Benchmark> = {}): Benchmark {
  return {
    id, name, user_id: 'u', original_filename: 'wildppg', file_size: 1000, file_checksum: 'c', file_ext: 'dataset',
    status: 'ready', created_at: '2026-11-12T10:00:00Z', compressors: [], ...extra,
  }
}

function res(compressor: string, ratio: number, tp: number, extra: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    id: compressor, benchmark_id: 'b', compressor, dataset: 'd', compression_ratio: ratio,
    compression_throughput_mbs: tp, decompression_throughput_mbs: tp * 2, num_values: 100,
    compressed_bits: ratio * 6400, uncompressed_bits: 6400, ...extra,
  }
}

const data: Record<string, { benchmark: Benchmark; results: BenchmarkResult[] }> = {
  a: { benchmark: bench('a', 'wild · std · 768', { source: source(768), file_count: 20 }), results: [res('gzip', 0.3, 10), res('zstd', 0.4, 300), res('my_codec', 0.2, 5, { self_test_failures: 2 })] },
  b: { benchmark: bench('b', 'wild · std · 4096', { source: source(4096) }), results: [res('gzip', 0.25, 12), res('zstd', 0.35, 320)] },
  r: { benchmark: bench('r', 'running one', { status: 'in_progress', progress: 40 }), results: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedFetch.mockImplementation(async (path: string) => {
    const m = /^\/benchmarks\/(\w+)(\/tasks|\/series)?$/.exec(path)
    if (m && m[2] === '/series') {
      return { series: m[1] === 'a' ? [{ series: 'ppg', results: [res('gzip', 0.5, 9)] }, { series: 'temp', results: [res('gzip', 0.1, 11)] }] : [] } as never
    }
    if (m && m[2]) return { tasks: [] } as never
    if (m) return data[m[1]] as never
    return {} as never
  })
})

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/experiments/view" element={<ExperimentView />} /></Routes>
    </MemoryRouter>,
  )
}

describe('ExperimentView', () => {
  it('shows one benchmark with its Pareto top 5, metric tabs and self-test badge', async () => {
    renderAt('/experiments/view?ids=a')
    expect(await screen.findByRole('heading', { name: 'wild · std · 768' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Throughput' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Pareto' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Sweep' })).not.toBeInTheDocument()
    expect(screen.getByText(/Top 5/)).toBeInTheDocument()
    expect(screen.getAllByText('self-test failed').length).toBeGreaterThan(0)
  })

  it('hides compressors through the filter', async () => {
    renderAt('/experiments/view?ids=a')
    await screen.findByRole('heading', { name: 'wild · std · 768' })
    const filter = screen.getAllByLabelText('Compressor filter').at(-1)!
    await userEvent.click(within(filter).getByRole('checkbox', { name: /Zstd/ }))
    expect(within(filter).getByText('2/3')).toBeInTheDocument()
  })

  it('compares several benchmarks and detects a chunk-size sweep', async () => {
    renderAt('/experiments/view?ids=a,b')
    expect(await screen.findByRole('heading', { name: 'wild · std' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Benchmarks in this view' })).toHaveTextContent('wild · std · 4096')
    expect(screen.getAllByRole('columnheader', { name: /Gzip/ }).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: 'Sweep' }))
    // Every metric is plotted; chips switch them off.
    const metricsFilter = screen.getByRole('group', { name: 'Sweep metrics' })
    const label = 'Compression Ratio (%)'
    expect(within(metricsFilter).getAllByRole('button', { pressed: true }).length).toBeGreaterThan(1)
    expect(screen.getAllByText(label)).toHaveLength(2) // chip + chart title
    await userEvent.click(within(metricsFilter).getByRole('button', { name: label, pressed: true }))
    expect(within(metricsFilter).getByRole('button', { name: label, pressed: false })).toBeInTheDocument()
    expect(screen.getAllByText(label)).toHaveLength(1) // only the chip is left
    await userEvent.click(within(metricsFilter).getByRole('button', { name: 'None' }))
    expect(screen.getByText(/Every metric is switched off/)).toBeInTheDocument()
  })

  it('splits each benchmark into its signals when time series are not aggregated', async () => {
    renderAt('/experiments/view?ids=a')
    await screen.findByRole('heading', { name: 'wild · std · 768' })
    const aggregateSwitch = screen.getByRole('switch', { name: 'Aggregate time series' })
    expect(aggregateSwitch).toBeChecked()
    expect(mockedFetch).not.toHaveBeenCalledWith('/benchmarks/a/series')

    await userEvent.click(aggregateSwitch)
    expect(mockedFetch).toHaveBeenCalledWith('/benchmarks/a/series')
    // The aggregate and each signal become rows of the comparison.
    expect(await screen.findAllByRole('cell', { name: 'wild · std · 768 · ppg' })).not.toHaveLength(0)
    expect(screen.getAllByRole('cell', { name: 'wild · std · 768 · all (mean)' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('cell', { name: 'wild · std · 768 · temp' }).length).toBeGreaterThan(0)
  })

  it('hides the switch when every benchmark has a single input', async () => {
    renderAt('/experiments/view?ids=b')
    await screen.findByRole('heading', { name: 'wild · std · 4096' })
    expect(screen.queryByRole('switch', { name: 'Aggregate time series' })).not.toBeInTheDocument()
  })

  it('monitors runs that are not ready', async () => {
    renderAt('/experiments/view?ids=r')
    expect(await screen.findByRole('region', { name: 'Run running one' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
  })

  it('offers Share only to the owner of every benchmark', async () => {
    const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub, exp: 9999999999 }))}.s`
    useAuthStore.setState({ token: jwt('u') })
    const { unmount } = renderAt('/experiments/view?ids=a,b')
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    expect(screen.getByRole('dialog', { name: /Share/ })).toBeInTheDocument()
    unmount()
    useAuthStore.setState({ token: jwt('someone-else') })
    renderAt('/experiments/view?ids=a')
    await screen.findByRole('heading', { name: 'wild · std · 768' })
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
    useAuthStore.setState({ token: null })
  })
})

describe('ExperimentView Pareto tab', () => {
  it('defaults to every compressor averaged over the benchmarks', async () => {
    renderAt('/experiments/view?ids=a,b&tab=pareto')
    const select = await screen.findByRole('combobox', { name: /Benchmark/ })
    expect(select).toHaveValue('average')
    expect(within(select).getByRole('option', { name: 'Average of all 2 benchmarks' })).toBeInTheDocument()
    // gzip: ratio (0.30 + 0.25) / 2.
    expect(screen.getByText(/27\.50?%/)).toBeInTheDocument()
    await userEvent.selectOptions(select, 'b')
    expect(screen.getByText(/25\.00?%/)).toBeInTheDocument()
  })
})

describe('ExperimentView on a phone', () => {
  beforeEach(() => setPhone(true))
  afterEach(() => { vi.unstubAllGlobals(); useAuthStore.setState({ token: null }) })

  it('moves the compressor filter and page actions into sheets', async () => {
    useAuthStore.setState({ token: `h.${btoa(JSON.stringify({ sub: 'u', exp: 9999999999 }))}.s` })
    renderAt('/experiments/view?ids=a')
    await screen.findByRole('heading', { name: 'wild · std · 768' })
    expect(screen.queryByRole('button', { name: /Download all results/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Compressor filter')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Compressors 3\/3/ }))
    const filter = screen.getByRole('dialog', { name: 'Show compressors' })
    await userEvent.click(within(filter).getByRole('checkbox', { name: /Gzip/ }))
    expect(screen.getByRole('button', { name: /Compressors 2\/3/ })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const actions = screen.getByRole('dialog', { name: 'Actions' })
    expect(within(actions).getByRole('button', { name: /Download all results/ })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: 'Share' })).toBeInTheDocument()
    expect(within(actions).getByLabelText(/Aggregate time series/)).toBeInTheDocument()
  })
})
