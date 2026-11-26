import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn()
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

const { useChartStyles } = await import('./chart-styles-store')
const { renameCompressor } = await import('@/lib/compressors')
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
    expect(lastBody()).toEqual({ shapes: { gzip: 'x' }, colors: { gorilla: '#d62728' }, names: {} })

    apiFetch.mockImplementationOnce(echo)
    await useChartStyles.getState().setShape('Gorilla', 'hexagon')
    expect(lastBody()).toEqual({ shapes: { gzip: 'x', gorilla: 'hexagon' }, colors: { gorilla: '#d62728' }, names: {} })

    apiFetch.mockImplementationOnce(echo)
    await useChartStyles.getState().setName('Gorilla', ' My Gorilla ')
    expect(lastBody().names).toEqual({ gorilla: 'My Gorilla' })
    // Every display name comes from the saved names.
    expect(renameCompressor('Gorilla')).toBe('My Gorilla')
    expect(renameCompressor('gzip')).toBe('Gzip')

    apiFetch.mockImplementationOnce(echo)
    await useChartStyles.getState().reset(['GORILLA'])
    expect(useChartStyles.getState().shapes).toEqual({ gzip: 'x' })
    expect(useChartStyles.getState().colors).toEqual({})
    expect(useChartStyles.getState().names).toEqual({})
    expect(renameCompressor('Gorilla')).toBe('Gorilla')
  })

  it('rolls back and reports when saving fails', async () => {
    apiFetch.mockRejectedValueOnce(new Error('colour must be #rrggbb'))
    await useChartStyles.getState().setColor('gzip', '#000000')
    expect(useChartStyles.getState().colors).toEqual({})
    expect(useChartStyles.getState().error).toBe('colour must be #rrggbb')
  })

  it('keeps changes in memory in local mode (shared links)', async () => {
    useChartStyles.getState().useLocal({ colors: { gzip: '#123456' } })
    await useChartStyles.getState().setShape('Gzip', 'star')
    await useChartStyles.getState().setName('Gzip', 'Mine')
    expect(useChartStyles.getState().shapes).toEqual({ gzip: 'star' })
    expect(useChartStyles.getState().colors).toEqual({ gzip: '#123456' })
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
