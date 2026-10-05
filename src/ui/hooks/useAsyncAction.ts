import { useCallback, useRef, useState } from 'react'
import { ipcErrorMessage } from '../ipcError'
import { useToast } from '../components/Toast'

/**
 * Runs an async command once at a time, exposes `pending` for the button and reports a thrown error
 * as a toast. Commands whose failures the launcher state already shows should not use the toast.
 */
export function useAsyncAction(): { pending: boolean; run: <T>(action: () => Promise<T>, options?: { silent?: boolean }) => Promise<T | undefined> } {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const toast = useToast()

  const run = useCallback(
    async <T,>(action: () => Promise<T>, options: { silent?: boolean } = {}): Promise<T | undefined> => {
      if (inFlight.current) return undefined
      inFlight.current = true
      setPending(true)
      try {
        return await action()
      } catch (err) {
        if (!options.silent) toast({ kind: 'error', message: ipcErrorMessage(err) })
        return undefined
      } finally {
        inFlight.current = false
        setPending(false)
      }
    },
    [toast]
  )

  return { pending, run }
}
