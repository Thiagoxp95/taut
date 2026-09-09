import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'
import { Loader2, PlugZap } from 'lucide-react'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Label } from '@taut/ui/components/label'
/**
 * "Connect to your Taut" — the only screen the shell renders itself. Every
 * other pixel comes from the instance the user points it at.
 */
export default function App() {
  const [url, setUrl] = useState('')
  const [configured, setConfigured] = useState(undefined)
  const [error, setError] = useState(undefined)
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
  const submit = (event) => {
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
      (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setBusy(false)
      }
    )
  }
  return _jsxs('main', {
    className: 'flex h-full flex-col bg-background text-foreground',
    children: [
      _jsx('div', { className: 'taut-titlebar' }),
      _jsxs('div', {
        className: 'flex flex-1 flex-col justify-center gap-6 px-9 pb-10',
        children: [
          _jsxs('header', {
            className: 'flex flex-col gap-1.5',
            children: [
              _jsx('span', {
                'aria-hidden': true,
                className: 'text-3xl',
                children: '\uD83E\uDDF5'
              }),
              _jsx('h1', {
                className: 'text-xl font-semibold tracking-tight',
                children: 'Connect to your Taut'
              }),
              _jsx('p', {
                className: 'text-sm text-muted-foreground',
                children: 'Taut is self-hosted, so the app needs the address of your server.'
              })
            ]
          }),
          _jsxs('form', {
            className: 'flex flex-col gap-4',
            onSubmit: submit,
            children: [
              _jsxs('div', {
                className: 'flex flex-col gap-2',
                children: [
                  _jsx(Label, { htmlFor: 'instance', children: 'Instance URL' }),
                  _jsx(Input, {
                    id: 'instance',
                    autoFocus: true,
                    spellCheck: false,
                    autoCapitalize: 'off',
                    autoCorrect: 'off',
                    placeholder: 'http://localhost:3000',
                    value: url,
                    disabled: busy,
                    onChange: (event) => setUrl(event.target.value)
                  }),
                  error === undefined
                    ? _jsx('p', {
                        className: 'text-xs text-muted-foreground',
                        children:
                          configured === undefined
                            ? 'We will check /api/health before opening it.'
                            : `Currently connected to ${configured}.`
                      })
                    : _jsx('p', {
                        role: 'alert',
                        className: 'text-xs text-destructive',
                        children: error
                      })
                ]
              }),
              _jsxs(Button, {
                type: 'submit',
                disabled: busy || url.trim().length === 0,
                children: [
                  busy ? _jsx(Loader2, { className: 'animate-spin' }) : _jsx(PlugZap, {}),
                  busy ? 'Checking…' : 'Connect'
                ]
              })
            ]
          })
        ]
      })
    ]
  })
}
