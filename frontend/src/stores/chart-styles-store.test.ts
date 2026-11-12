import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn()
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const { useChartStyles } = await import('./chart-styles-store')
const echo = async (_path: string, init: RequestInit) => JSON.parse(String(init.body))
const lastBody = () => JSON.parse(apiFetch.mock.lastCall![1].body)

describe('chart styles store', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    useChartStyles.getState().clear()
  })

  it('loads the overrides and saves shapes and colours together', async () => {
    apiFetch.mockResolvedValueOnce({ shapes: { gzip: 'x' }, colors: {} })
    await useChartStyles.getState().load()
    expect(useChartStyles.getState().shapes).toEqual({ gzip: 'x' })

    apiFetch.mockImplementationOnce(echo)
    await useChartStyles.getState().setColor('Gorilla', '#d62728')
    expect(apiFetch).toHaveBeenLastCalledWith('/me/chart-styles', expect.objectContaining({ method: 'PUT' }))
    expect(lastBody()).toEqual({ shapes: { gzip: 'x' }, colors: { gorilla: '#d62728' } })

    apiFetch.mockImplementationOnce(echo)
    await useChartStyles.getState().setShape('Gorilla', 'hexagon')
    expect(lastBody()).toEqual({ shapes: { gzip: 'x', gorilla: 'hexagon' }, colors: { gorilla: '#d62728' } })

    apiFetch.mockImplementationOnce(echo)
    await useChartStyles.getState().reset(['GORILLA'])
    expect(useChartStyles.getState().shapes).toEqual({ gzip: 'x' })
    expect(useChartStyles.getState().colors).toEqual({})
  })

  it('rolls back and reports when saving fails', async () => {
    apiFetch.mockRejectedValueOnce(new Error('colour must be #rrggbb'))
    await useChartStyles.getState().setColor('gzip', '#000000')
    expect(useChartStyles.getState().colors).toEqual({})
    expect(useChartStyles.getState().error).toBe('colour must be #rrggbb')
  })
})
