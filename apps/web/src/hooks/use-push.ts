import * as React from 'react'
import { toast } from '@taut/ui/components/sonner'

import { disablePush, enablePush, readPushState, PushUnavailable, type PushState } from '@/lib/push'
import { runtime } from '@/lib/runtime'

export interface Push {
  readonly state: PushState
  readonly busy: boolean
  /** Call from a click handler only — browsers reject a permission prompt without a gesture. */
  readonly toggle: () => void
}

/**
 * Notification enrolment for this browser, as a two-state toggle.
 *
 * The state is read from the browser (permission + existing subscription), never from
 * the server: the same account on two devices is genuinely two different answers.
 */
export const usePush = (): Push => {
  const [state, setState] = React.useState<PushState>('unsupported')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let live = true
    void runtime.runPromise(readPushState()).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [])

  const toggle = React.useCallback(() => {
    if (busy) return
    setBusy(true)
    const action = state === 'on' ? disablePush() : enablePush()
    void runtime
      .runPromise(action)
      .then((next) => {
        setState(next)
        if (next === 'on') toast.success('Notifications are on for this device.')
      })
      .catch((error: unknown) => {
        if (error instanceof PushUnavailable) {
          setState(error.state)
          toast.error(error.message)
          return
        }
        toast.error('Could not change notification settings.')
      })
      .finally(() => setBusy(false))
  }, [busy, state])

  return { state, busy, toggle }
}
