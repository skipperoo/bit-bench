import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useIsPhone } from '@/lib/responsive'
import { cn } from '@/lib/utils'

const OUT_MS = 200

/**
 * A panel over the page: a bottom sheet on phones (drag the handle down or tap
 * outside to close), a centred dialog on larger screens. Escape closes both.
 */
export function Sheet({ open, onClose, title, children, footer, className, wide }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  /** Sticks to the bottom of the panel (actions). */
  footer?: ReactNode
  className?: string
  /** Wider desktop dialog (max-w-2xl instead of max-w-lg). */
  wide?: boolean
}) {
  const phone = useIsPhone()
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const [drag, setDrag] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const start = useRef<number | null>(null)

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Two frames so the closed position paints before the transition starts.
      let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setShown(true)) })
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), OUT_MS)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [open, onClose])

  if (!mounted) return null

  const handle = phone && (
    <div
      className="flex justify-center pb-1 pt-2 touch-none cursor-grab"
      onPointerDown={(e) => { start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { if (start.current !== null) setDrag(Math.max(0, e.clientY - start.current)) }}
      onPointerUp={() => {
        if (drag > 80) onClose()
        start.current = null
        setDrag(0)
      }}
      onPointerCancel={() => { start.current = null; setDrag(0) }}
    >
      <span className="h-1 w-9 rounded-full bg-border" aria-hidden="true" />
    </div>
  )

  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex', phone ? 'items-end' : 'items-center justify-center p-4')}>
      <div
        className={cn('absolute inset-0 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none', shown ? 'opacity-100' : 'opacity-0')}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
        className={cn(
          'relative flex max-h-[90dvh] w-full flex-col bg-background outline-none motion-reduce:transition-none',
          phone
            ? cn('rounded-t-2xl border-t border-border pb-[env(safe-area-inset-bottom)] transition-[translate] ease-[cubic-bezier(.2,.8,.2,1)]',
              shown ? 'duration-[260ms]' : 'translate-y-full duration-200')
            : cn('rounded-lg border border-border shadow-lg transition-[opacity,scale] duration-150', wide ? 'max-w-2xl' : 'max-w-lg', shown ? '' : 'scale-[.98] opacity-0'),
          className,
        )}
      >
        {handle}
        <div className={cn('flex items-start justify-between gap-3 px-5', phone ? 'pb-2' : 'pb-3 pt-5')}>
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
        {footer && <div className="border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
