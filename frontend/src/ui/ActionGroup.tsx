import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Button from './Button'
import './ActionGroup.css'

// Dialogs opened by a disclosed action should return to the visible trigger.
export function actionFocusReturnTarget(): HTMLElement | null {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const trigger = focused?.closest('.action-group')?.querySelector<HTMLElement>('.action-group-trigger')
  return trigger?.getClientRects().length ? trigger : focused
}

// The same controls form a toolbar in a wide pane and a disclosure in a narrow one.
export default function ActionGroup({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const content = panel.current
      if (!anchor || !content) return
      const width = Math.min(280, window.innerWidth - 16)
      const below = window.innerHeight - anchor.bottom - 8
      const above = anchor.top - 8
      const height = content.scrollHeight
      const useAbove = height > below && above > below
      const available = Math.max(0, useAbove ? above : below)
      setPosition({ top: useAbove ? Math.max(8, anchor.top - Math.min(height, available) - 6) : anchor.bottom + 6, left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)), width, maxHeight: available })
    }
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    place()
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  return <div className={`action-group ${className}${open ? ' is-open' : ''}`} ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
  }}>
    <Button className="action-group-trigger" ref={trigger} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>{label}<span aria-hidden="true">⌄</span></Button>
    <div id={id} className="action-group-panel" ref={panel} style={position} onClick={(event) => {
      // Nested panels own their async actions, errors and dismissal.
      const command = (event.target as HTMLElement).closest('button')
      if (command?.parentElement === panel.current) {
        // A command may focus the editor itself; otherwise do not leave focus in a hidden panel.
        if (panel.current?.contains(document.activeElement)) trigger.current?.focus()
        setOpen(false)
      }
    }}>{children}</div>
  </div>
}
