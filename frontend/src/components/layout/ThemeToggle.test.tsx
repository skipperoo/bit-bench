import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeToggle } from './ThemeToggle'
import { isDark, storedTheme } from '@/lib/theme'

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('resolves system/light/dark', () => {
    expect(isDark('dark', false)).toBe(true)
    expect(isDark('light', true)).toBe(false)
    expect(isDark('system', true)).toBe(true)
    expect(isDark('system', false)).toBe(false)
    expect(storedTheme()).toBe('system')
  })

  it('switches the document theme and remembers the choice', async () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Follow the system theme', pressed: true })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dark theme' }))
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('bitbench-theme')).toBe('dark')

    await userEvent.click(screen.getByRole('button', { name: 'Light theme' }))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(storedTheme()).toBe('light')

    await userEvent.click(screen.getByRole('button', { name: 'Follow the system theme' }))
    expect(localStorage.getItem('bitbench-theme')).toBeNull()
  })
})
