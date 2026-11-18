import { cloneElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// jsdom has no layout: give the chart a fixed size.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 600, height: 400 }),
}))

const { MetricScatterChart } = await import('./MetricCharts')

describe('MetricScatterChart tooltip', () => {
  it('shows the card only while the mouse is over a marker', () => {
    const { container } = render(
      <MetricScatterChart
        metric="compression_throughput_mbs"
        colors={new Map()}
        rows={[
          { compressor: 'gzip', ratio: 0.3, value: 50 },
          { compressor: 'zstd', ratio: 0.6, value: 300 },
        ]}
      />,
    )
    const marker = () => container.querySelector('[data-marker]') as Element
    expect(screen.queryByText('Ratio')).not.toBeInTheDocument()

    fireEvent.mouseEnter(marker())
    expect(screen.getByText('Ratio')).toBeInTheDocument()
    expect(screen.getAllByText('Gzip')).toHaveLength(2) // legend + card

    // Moving over the marker keeps the card; moving off it closes it.
    fireEvent.mouseMove(marker())
    expect(screen.getByText('Ratio')).toBeInTheDocument()
    fireEvent.mouseMove(container.querySelector('.recharts-cartesian-grid')!)
    expect(screen.queryByText('Ratio')).not.toBeInTheDocument()

    // Leaving the plot closes it too.
    fireEvent.mouseEnter(marker())
    fireEvent.mouseLeave(screen.getByTestId('scatter-compression_throughput_mbs').firstElementChild!)
    expect(screen.queryByText('Ratio')).not.toBeInTheDocument()
  })
})
