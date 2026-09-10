import * as React from 'react'
import type { AgentConnector, UpdateConnectorInput } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { PlusIcon, XIcon } from '@taut/ui/components/icons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import type { ConnectorPreset } from '@/lib/connector-catalog'

type HeaderRow = { id: number; name: string; value: string }

/** Mounted only while open: plaintext header drafts disappear on close. */
export function ConnectorDialog({
  initial,
  onClose,
  onSave,
  pending = false,
  error
}: {
  initial: ConnectorPreset | AgentConnector
  onClose: () => void
  onSave: (input: UpdateConnectorInput) => void
  pending?: boolean
  error?: string | undefined
}) {
  const editing = 'id' in initial
  const oauthOnly = 'auth' in initial && initial.auth === 'oauth'
  const [name, setName] = React.useState(initial.name)
  const [url, setUrl] = React.useState(initial.url ?? '')
  const [replaceHeaders, setReplaceHeaders] = React.useState(!editing)
  const [headers, setHeaders] = React.useState<HeaderRow[]>([{ id: 0, name: '', value: '' }])
  const nextId = React.useRef(1)
  const [problem, setProblem] = React.useState<{
    field: 'url' | 'headers'
    message: string
  } | null>(null)
  const id = React.useId()
  const changeHeader = (rowId: number, patch: Partial<HeaderRow>) =>
    setHeaders((rows) => rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)))
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (pending || oauthOnly) return
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      setProblem({ field: 'url', message: 'Enter a valid connector URL.' })
      return
    }
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      setProblem({
        field: 'url',
        message: 'Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.'
      })
      return
    }
    const entries: [string, string][] = []
    const names = new Set<string>()
    if (replaceHeaders)
      for (const row of headers) {
        const key = row.name.trim()
        if (!key && !row.value) continue
        if (
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
          !row.value.trim() ||
          /[\r\n]/.test(row.value)
        ) {
          setProblem({
            field: 'headers',
            message: 'Give each header a valid name and a nonempty value without line breaks.'
          })
          return
        }
        if (names.has(key.toLowerCase())) {
          setProblem({ field: 'headers', message: 'Header names must be unique.' })
          return
        }
        names.add(key.toLowerCase())
        entries.push([key, row.value])
      }
    setProblem(null)
    onSave({
      name: name.trim() || parsed.hostname,
      url: parsed.href,
      ...(replaceHeaders ? { headers: Object.fromEntries(entries) } : {})
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          document.querySelector<HTMLButtonElement>('[data-connector-add] button')?.focus()
        }}
      >
        <form onSubmit={submit} className="grid gap-6" aria-busy={pending}>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? 'Edit connector'
                : initial.name
                  ? `Add ${initial.name} connector`
                  : 'Add custom MCP connector'}
            </DialogTitle>
            <DialogDescription>
              Give this agent access to tools from a remote MCP server.
            </DialogDescription>
          </DialogHeader>
          {oauthOnly ? (
            <p
              role="status"
              className="rounded-lg border bg-muted p-4 text-sm text-muted-foreground"
            >
              This provider requires browser sign-in. OAuth connections are not available yet. Use a
              custom connector that supports authentication headers.
            </p>
          ) : null}
          <div className="grid gap-2">
            <label htmlFor={`${id}-url`} className="text-sm font-medium">
              Connector URL
            </label>
            <Input
              id={`${id}-url`}
              type="url"
              required
              autoFocus
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
              autoComplete="off"
              aria-invalid={problem?.field === 'url'}
              aria-describedby={problem || error ? `${id}-error` : undefined}
              disabled={pending || oauthOnly}
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Uses the server hostname"
              disabled={pending || oauthOnly}
            />
          </div>
          {!oauthOnly ? (
            <fieldset disabled={pending} className="grid min-w-0 gap-3">
              <legend className="mb-1 text-sm font-medium">Authentication headers</legend>
              <p id={`${id}-headers`} className="text-xs text-muted-foreground">
                Header values are only visible while configuring this connector.
              </p>
              {!replaceHeaders && editing ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                  <span className="text-sm text-muted-foreground">
                    {initial.headerNames.length
                      ? `${initial.headerNames.join(', ')} · saved securely`
                      : 'No authentication headers'}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setReplaceHeaders(true)}
                  >
                    Replace headers
                  </Button>
                </div>
              ) : (
                <>
                  {editing ? (
                    <p className="text-xs text-muted-foreground">
                      These headers will replace all saved headers. Leave the list empty to remove
                      authentication.
                    </p>
                  ) : null}
                  {headers.map((row, index) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-end gap-2"
                    >
                      <div className="grid min-w-0 gap-2">
                        <label
                          htmlFor={`${id}-header-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          Header name
                        </label>
                        <Input
                          id={`${id}-header-${row.id}`}
                          value={row.name}
                          onChange={(event) => changeHeader(row.id, { name: event.target.value })}
                          placeholder="X-API-Key"
                          autoComplete="off"
                          aria-invalid={problem?.field === 'headers'}
                          aria-describedby={`${id}-headers${problem?.field === 'headers' ? ` ${id}-error` : ''}`}
                        />
                      </div>
                      <div className="grid min-w-0 gap-2">
                        <label
                          htmlFor={`${id}-value-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          Header value
                        </label>
                        <Input
                          id={`${id}-value-${row.id}`}
                          type="password"
                          value={row.value}
                          onChange={(event) => changeHeader(row.id, { value: event.target.value })}
                          placeholder="Secret"
                          autoComplete="new-password"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove header ${index + 1}`}
                        onClick={() =>
                          setHeaders((rows) => rows.filter((entry) => entry.id !== row.id))
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-fit rounded-full"
                    onClick={() =>
                      setHeaders((rows) => [...rows, { id: nextId.current++, name: '', value: '' }])
                    }
                  >
                    <PlusIcon /> Add header
                  </Button>
                </>
              )}
            </fieldset>
          ) : null}
          {problem || error ? (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {problem?.message ?? error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              className="rounded-full"
              onClick={onClose}
            >
              Cancel
            </Button>
            {!oauthOnly ? (
              <Button type="submit" disabled={pending} className="rounded-full">
                {pending ? 'Saving…' : editing ? 'Save connector' : 'Add connector'}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
