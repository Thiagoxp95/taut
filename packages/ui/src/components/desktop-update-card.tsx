import { useEffect, useState } from 'react'
import type { DesktopUpdateBridge, DesktopUpdateState } from '@taut/contract/desktop'
import { Button } from './button'

/** The optional bridge keeps browser clients and older desktop versions compatible. */
export function DesktopUpdateCard({ bridge }: { bridge?: DesktopUpdateBridge | undefined }) {
  const [state, setState] = useState<DesktopUpdateState>()
  const [dismissed, setDismissed] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!bridge) return
    let live = true
    let receivedEvent = false
    const unsubscribe = bridge.onState((next) => {
      receivedEvent = true
      if (live) {
        setState(next)
        setError(undefined)
      }
    })
    void bridge
      .state()
      .then((next) => {
        if (live && !receivedEvent) setState(next)
      })
      .catch(() => {})
    return () => {
      live = false
      unsubscribe()
    }
  }, [bridge])

  if (!bridge || !state || !['downloading', 'ready', 'restarting', 'error'].includes(state.status))
    return null
  const key = `${state.status}:${state.version}`
  if (dismissed === key) return null
  const run = (action: () => Promise<void>) => {
    setError(undefined)
    void action().catch(() => setError('Could not complete this action. Please try again.'))
  }
  return (
    <section
      aria-label="Desktop update"
      className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div role="status" aria-live="polite">
        <h2 className="text-sm font-semibold">
          {state.status === 'ready'
            ? `Taut ${state.version} is ready`
            : state.status === 'restarting'
              ? 'Restarting Taut…'
              : state.status === 'error'
                ? 'Update could not finish'
                : `Downloading Taut ${state.version}`}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {state.status === 'ready'
            ? 'Save your drafts before restarting. Active calls will end; your agents keep running on the server.'
            : state.status === 'error'
              ? state.message
              : state.status === 'restarting'
                ? 'Your workspace will reopen after the update.'
                : 'You can keep working while the update downloads.'}
        </p>
      </div>
      {state.status === 'downloading' && (
        <div className="mt-3 flex items-center gap-2">
          <progress
            aria-label="Update download"
            className="h-2 min-w-0 flex-1"
            max={100}
            value={state.percent}
          />
          <span className="text-xs tabular-nums">{state.percent}%</span>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {state.status !== 'restarting' && (
        <div className="mt-3 flex gap-2">
          {state.status === 'ready' && (
            <Button size="sm" onClick={() => run(bridge.restart)}>
              Restart to update
            </Button>
          )}
          {state.status === 'error' && (
            <Button size="sm" onClick={() => run(bridge.check)}>
              Try again
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDismissed(key)}>
            Later
          </Button>
        </div>
      )}
    </section>
  )
}
