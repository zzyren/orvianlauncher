import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from './cx'

export interface MenuItem {
  label: string
  icon?: ReactNode
  disabled?: boolean
  onSelect: () => void
}

interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string
  trigger: ReactNode
  items: MenuItem[]
  align?: 'start' | 'end'
  className?: string
}

/** Menu button (WAI-ARIA): arrows, Home/End, Esc and Tab behave as keyboard users expect. */
export function Menu({ label, trigger, items, align = 'end', className }: MenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()

  const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0)

  const focusItem = (index: number): void => itemRefs.current[index]?.focus()
  const close = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (open && enabled.length > 0) focusItem(enabled[0])
    // Only when it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement)
    const position = enabled.indexOf(current)
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusItem(enabled[(position + 1) % enabled.length])
        break
      case 'ArrowUp':
        event.preventDefault()
        focusItem(enabled[(position - 1 + enabled.length) % enabled.length])
        break
      case 'Home':
        event.preventDefault()
        focusItem(enabled[0])
        break
      case 'End':
        event.preventDefault()
        focusItem(enabled[enabled.length - 1])
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close(true)
        break
      case 'Tab':
        close(false)
        break
      default:
        break
    }
  }

  return (
    <div className={cx('menu', className)} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className={cx('menu-list', `menu-${align}`)} onKeyDown={onMenuKeyDown}>
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              disabled={item.disabled}
              onClick={() => {
                close(true)
                item.onSelect()
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
