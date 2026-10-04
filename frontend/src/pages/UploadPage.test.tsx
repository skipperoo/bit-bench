import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import UploadPage from './UploadPage'
import { apiFetch } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiUpload: vi.fn(),
}))

const mockedFetch = vi.mocked(apiFetch)

beforeEach(() => {
  vi.clearAllMocks()
  mockedFetch.mockResolvedValue({})
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
