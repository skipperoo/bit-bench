import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InstanceFilter from './InstanceFilter'
import type { StyleEditing } from './InstanceFilter'

const BLUE = '#1f77b4'

function setup(over: { shape?: string[]; color?: string[]; name?: string[] } = {}) {
  const editing: StyleEditing = {
    defaults: new Map([['gzip', { color: BLUE, shape: 'diamond' }], ['Gorilla', { color: BLUE, shape: 'circle' }]]),
    overridden: (n: string) => ({ shape: !!over.shape?.includes(n), color: !!over.color?.includes(n), name: !!over.name?.includes(n) }),
    onNameChange: vi.fn(),
    onShapeChange: vi.fn(),
    onColorChange: vi.fn(),
    onReset: vi.fn(),
  }
  const onHidden = vi.fn()
  render(
    <InstanceFilter
      names={['Gorilla', 'gzip']}
      colors={new Map([['gzip', BLUE], ['Gorilla', over.color?.includes('Gorilla') ? '#123456' : BLUE]])}
      shapes={new Map([['gzip', 'diamond'], ['Gorilla', over.shape?.includes('Gorilla') ? 'hexagon' : 'circle']])}
      hidden={new Set()}
      onChange={onHidden}
      styleEditing={editing}
    />,
  )
  return { editing, onHidden }
}

describe('InstanceFilter style editing', () => {
  it('opens a picker from the marker without toggling the compressor', async () => {
    const { editing, onHidden } = setup()
    await userEvent.click(screen.getByRole('button', { name: /Marker style of Gzip: Diamond, #1f77b4$/ }))
    expect(onHidden).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Name and marker style for Gzip' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Diamond (default)', pressed: true })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hexagon' }))
    expect(editing.onShapeChange).toHaveBeenCalledWith('gzip', 'hexagon')
    // The panel stays open so shape and colour can be set together.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('picks a palette colour or a custom colour', async () => {
    const { editing } = setup()
    await userEvent.click(screen.getByRole('button', { name: /Marker style of Gzip/ }))
    expect(screen.getByRole('button', { name: `${BLUE} (default)`, pressed: true })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '#0f766e' }))
    expect(editing.onColorChange).toHaveBeenCalledWith('gzip', '#0f766e')

    fireEvent.change(screen.getByLabelText('Custom colour for Gzip'), { target: { value: '#ABCDEF' } })
    expect(editing.onColorChange).toHaveBeenLastCalledWith('gzip', '#abcdef')
  })

  it('picking the defaults removes the overrides; Escape closes', async () => {
    const { editing } = setup({ shape: ['Gorilla'], color: ['Gorilla'] })
    await userEvent.click(screen.getByRole('button', { name: /Marker style of Gorilla: Hexagon, #123456 \(yours\)/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Circle (default)' }))
    expect(editing.onShapeChange).toHaveBeenCalledWith('Gorilla', null)
    await userEvent.click(screen.getByRole('button', { name: `${BLUE} (default)` }))
    expect(editing.onColorChange).toHaveBeenCalledWith('Gorilla', null)

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resets one compressor from its picker or every customised one of the view', async () => {
    const { editing } = setup({ color: ['Gorilla'] })
    await userEvent.click(screen.getByRole('button', { name: /Marker style of Gorilla/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(editing.onReset).toHaveBeenLastCalledWith(['Gorilla'])
    await userEvent.click(screen.getByRole('button', { name: 'Reset 1 style' }))
    expect(editing.onReset).toHaveBeenLastCalledWith(['Gorilla'])
  })

  it('renames a compressor; an empty or default name restores the default', async () => {
    const { editing } = setup()
    await userEvent.click(screen.getByRole('button', { name: /Marker style of Gzip/ }))
    const field = screen.getByLabelText('Display name for Gzip')
    expect(field).toHaveValue('Gzip')
    await userEvent.clear(field)
    await userEvent.type(field, '  Gzip-6 {Enter}')
    expect(editing.onNameChange).toHaveBeenLastCalledWith('gzip', 'Gzip-6')

    // Clearing a name that is already the default saves nothing and shows the default.
    await userEvent.clear(field)
    await userEvent.tab()
    expect(editing.onNameChange).toHaveBeenCalledTimes(1)
    expect(field).toHaveValue('Gzip')
  })

  it('clearing a renamed compressor restores its default name', async () => {
    const { editing } = setup({ name: ['gzip'] })
    await userEvent.click(screen.getByRole('button', { name: /Marker style of Gzip/ }))
    await userEvent.clear(screen.getByLabelText('Display name for Gzip'))
    await userEvent.tab()
    expect(editing.onNameChange).toHaveBeenCalledWith('gzip', null)
  })

  it('the name still toggles the compressor', async () => {
    const { onHidden } = setup()
    await userEvent.click(screen.getByText('Gzip'))
    expect(onHidden).toHaveBeenCalledWith(new Set(['gzip']))
  })
})
