import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { PhoneNav } from './PhoneNav'
import { setPhone } from '@/test/phone'

afterEach(() => vi.unstubAllGlobals())

describe('PhoneNav', () => {
  it('marks the current tab and keeps Status, theme and log out under More', async () => {
    setPhone(true)
    const onLogout = vi.fn()
    render(<MemoryRouter initialEntries={['/experiments/view?ids=a']}><PhoneNav onLogout={onLogout} /></MemoryRouter>)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(screen.getByRole('link', { name: 'Experiments' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'New' })).not.toHaveAttribute('aria-current')
    expect(nav).toHaveClass('md:hidden')

    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('link', { name: 'Status' })).toHaveAttribute('href', '/status')
    expect(screen.getByRole('group', { name: 'Colour theme' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(onLogout).toHaveBeenCalled()
  })
})
