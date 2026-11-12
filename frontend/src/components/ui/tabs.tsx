import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TabItem {
  value: string
  label: ReactNode
  disabled?: boolean
}

interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  className?: string
  /** Prefix for tab/panel ids so panels can reference their tab. */
  idPrefix?: string
}

/**
 * Accessible tab list (WAI-ARIA tabs pattern, arrow-key navigation). Render
 * the active panel with `<TabPanel>` using the same idPrefix.
 */
export function Tabs({ items, value, onChange, ariaLabel, className, idPrefix = 'tab' }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = items.filter((i) => !i.disabled)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((i) => i.value === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length
    else if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    const target = enabled[next]
    onChange(target.value)
    refs.current[items.indexOf(target)]?.focus()
  }

  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className={cn('flex flex-wrap gap-1 border-b border-border', className)}>
      {items.map((item, i) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.value}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors disabled:opacity-40',
              selected ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ value, idPrefix = 'tab', children, className }: { value: string; idPrefix?: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${value}`} aria-labelledby={`${idPrefix}-${value}`} className={className}>
      {children}
    </div>
  )
}
