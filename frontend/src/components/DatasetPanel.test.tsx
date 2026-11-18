import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DatasetPanel from './DatasetPanel'
import { DEFAULT_DATASET_SELECTION, datasetSelectionError } from '@/lib/datasets'
import type { DatasetListResponse, DatasetSelection } from '@/lib/datasets'

const catalog: DatasetListResponse = {
  datasets: [{
    name: 'finance',
    description: 'Daily closes',
    series: [
      { name: 'NVDA', values: 100_000, decimals: 2, size_bytes: 800_016 },
      { name: 'TINY', values: 300, decimals: 2, size_bytes: 2416 },
      { name: 'BROKEN', values: 0, decimals: 0, size_bytes: 3, error: 'invalid .bin file' },
    ],
  }],
  transforms: ['std', 'gap', 'gap_shifted'],
  max_runs: 32,
  max_inputs_per_run: 5000,
  max_chunks_per_series: 10000,
}

function Harness({ onChange }: { onChange?: (s: DatasetSelection) => void }) {
  const [selection, setSelection] = useState(DEFAULT_DATASET_SELECTION)
  return (
    <DatasetPanel
      catalog={catalog}
      selection={selection}
      onChange={(next) => { setSelection(next); onChange?.(next) }}
    />
  )
}

describe('DatasetPanel', () => {
  it('shows setup instructions when no dataset is mounted', () => {
    render(<DatasetPanel catalog={{ ...catalog, datasets: [] }} selection={DEFAULT_DATASET_SELECTION} onChange={() => {}} />)
    expect(screen.getByText(/No standardized datasets yet/)).toBeInTheDocument()
    expect(screen.getByText(/make_synthetic.py/)).toBeInTheDocument()
  })

  it('starts with no series, selects the usable ones and summarizes the plan', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Dataset'), 'finance')

    const last = onChange.mock.calls.at(-1)![0] as DatasetSelection
    expect(last.series).toEqual([]) // series start unchecked
    expect(screen.queryByTestId('dataset-plan')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect((onChange.mock.calls.at(-1)![0] as DatasetSelection).series).toEqual(['NVDA', 'TINY']) // BROKEN cannot be selected
    expect(screen.getByText('Daily closes')).toBeInTheDocument()
    expect((screen.getByRole('checkbox', { name: /BROKEN/ }) as HTMLInputElement).disabled).toBe(true)

    // Default: 768-sample chunks, 10 per series, std -> NVDA 10 inputs, TINY repeated into 1.
    const plan = screen.getByTestId('dataset-plan')
    expect(plan).toHaveTextContent('Creates 1 benchmark over 2 series')
    expect(plan).toHaveTextContent('std · 768 samples × ≤10 → 11 inputs')
    expect(plan).toHaveTextContent('repeats 1 short series')
    expect(screen.getByRole('status')).toHaveTextContent('1 series is shorter than the chunk size and will be repeated to fill one chunk')
    expect(screen.getByRole('status')).toHaveTextContent('TINY (300 values) at 768 samples')

    // Adding the whole series and the gap transform makes a 2 x 2 matrix.
    await userEvent.click(screen.getByRole('button', { name: 'whole series' }))
    await userEvent.click(screen.getByRole('button', { name: 'gap' }))
    expect(screen.getByTestId('dataset-plan')).toHaveTextContent('Creates 4 benchmarks')
  })

  it('adds a custom chunk size', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(screen.getByLabelText('Custom chunk size'), '1000{enter}')
    expect((onChange.mock.calls.at(-1)![0] as DatasetSelection).chunkSizes).toContain(1000)
  })
})

describe('datasetSelectionError', () => {
  const ds = catalog.datasets[0]
  it('explains what is missing', () => {
    expect(datasetSelectionError(DEFAULT_DATASET_SELECTION, undefined, catalog)).toBe('Choose a dataset')
    expect(datasetSelectionError({ ...DEFAULT_DATASET_SELECTION, dataset: 'finance' }, ds, catalog)).toBe('Select at least one series')
    // A chunk longer than every series is fine: the series are repeated.
    expect(datasetSelectionError({ ...DEFAULT_DATASET_SELECTION, dataset: 'finance', series: ['TINY'], chunkSizes: [4096] }, ds, catalog)).toBe('')
    expect(datasetSelectionError({ ...DEFAULT_DATASET_SELECTION, dataset: 'finance', series: ['NVDA'], chunkSizes: [2], maxChunks: 0 }, ds, catalog))
      .toMatch(/max 5000/)
    expect(datasetSelectionError({ ...DEFAULT_DATASET_SELECTION, dataset: 'finance', series: ['NVDA'] }, ds, catalog)).toBe('')
  })
})
