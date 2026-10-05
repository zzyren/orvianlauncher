import { useEffect, useState } from 'react'
import type { LauncherState } from '../../shared/launcher-state'

/** The launcher state owned by the main process: loaded once, then pushed on every change. */
export function useLauncherState(): LauncherState | null {
  const [state, setState] = useState<LauncherState | null>(null)

  useEffect(() => {
    let cancelled = false
    // A push that arrives before the first answer is newer, so it must win
    let pushed = false
    const unbind = window.orvian.onState((next) => {
      pushed = true
      setState(next)
    })
    void window.orvian.getState().then((initial) => {
      if (!cancelled && !pushed) setState(initial)
    })
    return () => {
      cancelled = true
      unbind()
    }
  }, [])

  return state
}
