import { useEffect, useRef, useState } from 'react'

/**
 * Turns a busy flag into one that does not flicker: it rises only after `showAfterMs` of continuous
 * activity and, once shown, stays on for at least `minVisibleMs`.
 */
export function useDelayedFlag(active: boolean, showAfterMs = 200, minVisibleMs = 400): boolean {
  const [shown, setShown] = useState(false)
  const shownAt = useRef(0)

  useEffect(() => {
    if (active) {
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now()
        setShown(true)
      }, showAfterMs)
      return () => window.clearTimeout(timer)
    }
    if (!shown) return
    const remaining = Math.max(0, minVisibleMs - (Date.now() - shownAt.current))
    const timer = window.setTimeout(() => setShown(false), remaining)
    return () => window.clearTimeout(timer)
  }, [active, shown, showAfterMs, minVisibleMs])

  return shown
}
