import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Sheet } from './sheet'
import { setPhone } from '@/test/phone'

afterEach(() => vi.unstubAllGlobals())

describe('Sheet', () => {
  it('is a bottom sheet with a drag handle on phones', () => {
    setPhone(true)
    render(<Sheet open onClose={() => {}} title="Filters">body</Sheet>)
    const dialog = screen.getByRole('dialog', { name: 'Filters' })
    expect(dialog.className).toContain('rounded-t-2xl')
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('is a centred dialog on desktop and closes on Escape or the backdrop', async () => {
    setPhone(false)
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Share">body</Sheet>)
    expect(screen.getByRole('dialog').className).toContain('rounded-lg')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
