import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import InstanceFilter from './InstanceFilter'
import type { ShapeEditing } from './InstanceFilter'

function setup(overridden: string[] = []) {
  const editing: ShapeEditing = {
    defaults: new Map([['gzip', 'diamond'], ['Gorilla', 'circle']]),
    overridden: (n) => overridden.includes(n),
    onChange: vi.fn(),
    onReset: vi.fn(),
  }
  const onHidden = vi.fn()
  render(
    <InstanceFilter
      names={['Gorilla', 'gzip']}
      colors={new Map([['gzip', '#1f77b4'], ['Gorilla', '#1f77b4']])}
      shapes={new Map([['gzip', 'diamond'], ['Gorilla', overridden.includes('Gorilla') ? 'hexagon' : 'circle']])}
      hidden={new Set()}
      onChange={onHidden}
      shapeEditing={editing}
    />,
  )
  return { editing, onHidden }
}

describe('InstanceFilter shape editing', () => {
  it('opens a picker from the marker without toggling the compressor', async () => {
    const { editing, onHidden } = setup()
    await userEvent.click(screen.getByRole('button', { name: /Marker shape of Gzip: Diamond/ }))
    expect(onHidden).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Marker shape for Gzip' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diamond (default)', pressed: true })).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: 'Hexagon' }))
    expect(editing.onChange).toHaveBeenCalledWith('gzip', 'hexagon')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('picking the default shape removes the override; Escape closes', async () => {
    const { editing } = setup(['Gorilla'])
    await userEvent.click(screen.getByRole('button', { name: /Marker shape of Gorilla: Hexagon \(yours\)/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Circle (default)' }))
    expect(editing.onChange).toHaveBeenCalledWith('Gorilla', null)

    await userEvent.click(screen.getByRole('button', { name: /Marker shape of Gorilla/ }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resets only the customised compressors of the view', async () => {
    const { editing } = setup(['Gorilla'])
    await userEvent.click(screen.getByRole('button', { name: 'Reset 1 shape' }))
    expect(editing.onReset).toHaveBeenCalledWith(['Gorilla'])
  })

  it('the name still toggles the compressor', async () => {
    const { onHidden } = setup()
    await userEvent.click(screen.getByText('Gzip'))
    expect(onHidden).toHaveBeenCalledWith(new Set(['gzip']))
  })
})
