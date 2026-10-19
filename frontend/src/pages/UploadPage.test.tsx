import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import UploadPage from './UploadPage'
import { apiFetch, apiUploadWithProgress } from '@/lib/api'
import type { UploadProgress } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiUpload: vi.fn(),
  apiUploadWithProgress: vi.fn(),
}))

const mockedFetch = vi.mocked(apiFetch)
const mockedUpload = vi.mocked(apiUploadWithProgress)

beforeEach(() => {
  vi.clearAllMocks()
  mockedFetch.mockResolvedValue({} as never)
})

function renderPage() {
  return render(
    <MemoryRouter>
      <UploadPage />
    </MemoryRouter>
  )
}

describe('UploadPage file list', () => {
  it('lists selected files in a scrollable area and removes individual files', async () => {
    const { container } = renderPage()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()

    const files = Array.from(
      { length: 7 },
      (_, i) => new File([`data-${i}`], `file${i}.bin`, { type: 'application/octet-stream' })
    )
    await userEvent.upload(input, files)

    expect(await screen.findByText('7 files')).toBeInTheDocument()

    // Every selected file starts in the ready state.
    expect(screen.getAllByText('Ready')).toHaveLength(7)

    const list = screen.getByTestId('file-list')
    expect(list).toHaveClass('overflow-y-auto')
    expect(list).toHaveClass('max-h-[13rem]')

    expect(screen.getAllByRole('button', { name: /^Remove file/ })).toHaveLength(7)

    await userEvent.click(screen.getByRole('button', { name: 'Remove file0.bin' }))

    expect(screen.queryByRole('button', { name: 'Remove file0.bin' })).not.toBeInTheDocument()
    expect(screen.getByText('6 files')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove file/ })).toHaveLength(6)
  })
})

describe('UploadPage upload progress', () => {
  it('ticks files as their bytes are uploaded and while the server processes', async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === '/compressors') {
        return Promise.resolve({
          gzip: { level: { type: 'number', min: 1, max: 9, default: 6, step: 1 } },
        } as never)
      }
      return Promise.resolve({} as never)
    })

    let progressCb: ((progress: UploadProgress) => void) | undefined
    let resolveUpload: ((value: unknown) => void) | undefined
    mockedUpload.mockImplementation((_path, _formData, onProgress) => {
      progressCb = onProgress
      return new Promise((resolve) => {
        resolveUpload = resolve
      }) as never
    })

    const { container } = renderPage()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [new File(['xxxx'], 'one.bin')])
    await screen.findByText('1 files')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Gzip' }))
    await userEvent.click(screen.getByRole('button', { name: 'Run Benchmark' }))

    // Part of the file has been handed to the socket: still uploading.
    await act(async () => {
      progressCb?.({ loaded: 2, total: 100 })
    })
    expect(screen.getByText('Uploading')).toBeInTheDocument()
    expect(screen.getByTestId('file-list').firstChild).toHaveAttribute('data-status', 'uploading')

    // All bytes sent: the server is normalizing, the row shows processing.
    await act(async () => {
      progressCb?.({ loaded: 100, total: 100 })
    })
    await waitFor(() => expect(screen.getByText('Processing')).toBeInTheDocument())
    expect(screen.getByText('Upload complete — processing on the server…')).toBeInTheDocument()

    // Response arrives: the file is done.
    await act(async () => {
      resolveUpload?.({ id: 'benchmark-1' })
    })
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument())
  })
})

describe('UploadPage emulation warning', () => {
  it('warns about packages that target another platform', async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === '/config') {
        return Promise.resolve({ hostPlatform: 'linux/amd64' } as never)
      }
      if (path === '/compressors') {
        return Promise.resolve({ example_pkg: {} } as never)
      }
      if (path === '/compressors/packages') {
        return Promise.resolve([
          { id: 'p1', name: 'example_pkg', status: 'ready', platform: 'linux/arm64', emulated: true },
        ] as never)
      }
      return Promise.resolve({} as never)
    })

    const { container } = renderPage()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [new File(['xxxx'], 'one.bin')])

    // The picker marks the package as emulated before it is even added.
    expect(await screen.findByTitle(/Targets arm64/)).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: 'Add example_pkg' }))

    const warning = await screen.findByTestId('emulation-warning')
    expect(warning).toHaveTextContent('example_pkg (arm64)')
    expect(screen.getByTestId('emulated-example_pkg')).toBeInTheDocument()

    // Removing the instance clears the warning.
    await userEvent.click(screen.getByRole('button', { name: 'Remove example_pkg' }))
    await waitFor(() => expect(screen.queryByTestId('emulation-warning')).not.toBeInTheDocument())
  })

  it('does not warn for native packages', async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === '/config') {
        return Promise.resolve({ hostPlatform: 'linux/amd64' } as never)
      }
      if (path === '/compressors') {
        return Promise.resolve({ native_pkg: {} } as never)
      }
      if (path === '/compressors/packages') {
        return Promise.resolve([
          { id: 'p2', name: 'native_pkg', status: 'ready', platform: 'linux/amd64', emulated: false },
        ] as never)
      }
      return Promise.resolve({} as never)
    })

    const { container } = renderPage()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [new File(['xxxx'], 'one.bin')])
    await userEvent.click(await screen.findByRole('button', { name: 'Add native_pkg' }))

    expect(screen.queryByTestId('emulation-warning')).not.toBeInTheDocument()
    expect(screen.queryByTestId('emulated-native_pkg')).not.toBeInTheDocument()
  })
})
