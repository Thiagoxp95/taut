import { DesktopUpdateCard } from '@taut/ui/components/desktop-update-card'
import { useEffect, useState } from 'react'
import { Loader2, PlugZap } from '@taut/ui/components/icons'

import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Label } from '@taut/ui/components/label'

/**
 * "Connect to your workspace" — the only screen the shell renders itself. Every
 * other pixel comes from the instance the user points it at.
 */
export default function App(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [configured, setConfigured] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.tautSetup?.state().then((state) => {
      if (!live) return
      setUrl(state.instanceUrl ?? state.defaultUrl)
      setConfigured(state.instanceUrl)
    })
    return () => {
      live = false
    }
  }, [])

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const bridge = window.tautSetup
    if (bridge === undefined || busy) return
    setBusy(true)
    setError(undefined)
    void bridge.connect(url).then(
      (result) => {
        // On success the main process swaps this window for the instance one.
        if (!result.ok) setError(result.message)
        setBusy(false)
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setBusy(false)
      }
    )
  }

  return (
    <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
      <div className="taut-titlebar" />
      <div className="flex flex-1 flex-col justify-center gap-6 px-9 pb-10">
        <header className="flex flex-col gap-1.5">
          <span aria-hidden className="text-3xl">
            🧵
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Connect to your workspace</h1>
          <p className="text-sm text-muted-foreground">
            Taut is self-hosted, so the app needs the address of your server.
          </p>
        </header>

        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="instance">Instance URL</Label>
            <Input
              id="instance"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="https://taut.example.com"
              value={url}
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
            {error === undefined ? (
              <p className="text-xs text-muted-foreground">
                {configured === undefined
                  ? 'Enter the server address provided by your workspace administrator.'
                  : `Currently connected to ${configured}.`}
              </p>
            ) : (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>

          <Button type="submit" disabled={busy || url.trim().length === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {busy ? 'Checking…' : 'Connect'}
          </Button>
        </form>
        <DesktopUpdateCard bridge={window.tautSetup?.updates} placement="inline" />
      </div>
    </main>
  )
}
