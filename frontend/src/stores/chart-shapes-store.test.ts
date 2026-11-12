import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn()
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const { useChartShapes } = await import('./chart-shapes-store')

describe('chart shapes store', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    useChartShapes.getState().clear()
  })

  it('loads the overrides and saves a change as the whole map', async () => {
    apiFetch.mockResolvedValueOnce({ shapes: { gzip: 'x' } })
    await useChartShapes.getState().load()
    expect(useChartShapes.getState().overrides).toEqual({ gzip: 'x' })

    apiFetch.mockImplementationOnce(async (_path: string, init: RequestInit) => JSON.parse(String(init.body)))
    await useChartShapes.getState().setShape('Gorilla', 'hexagon')
    expect(apiFetch).toHaveBeenLastCalledWith('/me/chart-shapes', expect.objectContaining({ method: 'PUT' }))
    expect(JSON.parse(apiFetch.mock.lastCall![1].body)).toEqual({ shapes: { gzip: 'x', gorilla: 'hexagon' } })
    expect(useChartShapes.getState().overrides).toEqual({ gzip: 'x', gorilla: 'hexagon' })

    apiFetch.mockImplementationOnce(async (_path: string, init: RequestInit) => JSON.parse(String(init.body)))
    await useChartShapes.getState().reset(['GZIP'])
    expect(useChartShapes.getState().overrides).toEqual({ gorilla: 'hexagon' })
  })

  it('rolls back and reports when saving fails', async () => {
    apiFetch.mockRejectedValueOnce(new Error('unknown shape'))
    await useChartShapes.getState().setShape('gzip', 'x')
    expect(useChartShapes.getState().overrides).toEqual({})
    expect(useChartShapes.getState().error).toBe('unknown shape')
  })
})
