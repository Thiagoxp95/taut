/**
 * The Browser pane (docs/build-plan-workspace.md D11, D12, D15, D16, D17):
 *
 * - the live view: `frame`s from the socket painted into one `<img>` (a JPEG each,
 *   ≤ 8 fps, sized by the server), with the pane's state (`off` → the
 *   `browserAccess` switch for whoever may manage the agent, D16; `starting`;
 *   `unavailable` with its reason);
 * - take control (D12): off by default. While this viewer holds control an overlay
 *   captures mouse, wheel and keyboard, maps pointer positions to fractions of the
 *   frame (the server scales them to the page) and sends `input` frames; a banner
 *   says "you are driving". Nothing is sent while control is off, and nothing typed
 *   here is ever kept or logged (D17).
 * - the interlock (D15): with a task running the button reads "Pause agent & take
 *   control" and asks for a confirmation; the server freezes the runtime for the
 *   hold and resumes it on release, disconnect or idle.
 * - below it, what the agent's own browsing produced: the newest files under
 *   `<home>/.taut/browser/out`, previewed through the home file read.
 */
import * as React from 'react'
import { GlobeIcon, HandIcon, ImageIcon, PauseIcon } from 'lucide-react'
import type { Agent, AgentId, FileEntry } from '@taut/contract'
import type { BrowserInputEvent, TerminalServerFrame } from '@taut/contract/terminal'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Switch } from '@taut/ui/components/switch'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/page'
import { SettingsSection } from '@/components/settings'
import { useAgentFiles, useMe, useUpdateAgent } from '@/lib/api'
import { formatBytes, formatRelative } from '@/lib/format'
import { usePresence } from '@/lib/live'
import { BROWSER_OUTPUT_DIR, agentFileUrl, type WorkspaceSocket } from '@/lib/workspace'

type BrowserState = Extract<TerminalServerFrame, { _tag: 'browser' }>
type ControlState = Extract<TerminalServerFrame, { _tag: 'control' }>
const NOBODY: ControlState = { _tag: 'control', holder: null, paused: false }

/** CDP modifier bits. */
const modifiersOf = (e: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

const buttonOf = (button: number): 'left' | 'middle' | 'right' | 'none' =>
  button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none'

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Pointer position as a fraction of the frame. */
const positionIn = (
  element: HTMLElement,
  e: { clientX: number; clientY: number }
): { x: number; y: number } => {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.width === 0 ? 0 : clamp01((e.clientX - rect.left) / rect.width),
    y: rect.height === 0 ? 0 : clamp01((e.clientY - rect.top) / rect.height)
  }
}

/** Keys whose `keyDown` carries no text; everything else (one printable char) does. */
const textOf = (e: React.KeyboardEvent): string | undefined =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined

const MOUSEMOVE_INTERVAL_MS = 33

function LiveView({
  socket,
  driving
}: {
  socket: WorkspaceSocket
  /** This viewer holds control: capture input. */
  driving: boolean
}) {
  const imgRef = React.useRef<HTMLImageElement>(null)
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null)
  const lastMove = React.useRef(0)

  React.useEffect(() => {
    const off = socket.on('frame', (frame) => {
      const img = imgRef.current
      if (img !== null) img.src = `data:image/jpeg;base64,${frame.data}`
      setSize((prev) =>
        prev !== null && prev.width === frame.width && prev.height === frame.height
          ? prev
          : { width: frame.width, height: frame.height }
      )
    })
    return off
  }, [socket])

  React.useEffect(() => {
    if (driving) overlayRef.current?.focus()
  }, [driving])

  const send = (event: BrowserInputEvent) => socket.send({ _tag: 'input', event })

  const handleMouse = (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    e: React.MouseEvent
  ) => {
    const overlay = overlayRef.current
    if (!driving || overlay === null) return
    e.preventDefault()
    if (type === 'mouseMoved') {
      const now = performance.now()
      if (now - lastMove.current < MOUSEMOVE_INTERVAL_MS) return
      lastMove.current = now
    }
    const { x, y } = positionIn(overlay, e)
    send({
      _tag: 'mouse',
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : buttonOf(e.button),
      clickCount: type === 'mouseMoved' ? 0 : Math.min(3, Math.max(1, e.detail)),
      modifiers: modifiersOf(e)
    })
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!driving || overlayRef.current === null) return
    e.preventDefault()
    const { x, y } = positionIn(overlayRef.current, e)
    send({
      _tag: 'mouse',
      type: 'mouseWheel',
      x,
      y,
      button: 'none',
      deltaX: Math.max(-10_000, Math.min(10_000, e.deltaX)),
      deltaY: Math.max(-10_000, Math.min(10_000, e.deltaY)),
      modifiers: modifiersOf(e)
    })
  }

  const handleKey = (type: 'keyDown' | 'keyUp', e: React.KeyboardEvent) => {
    if (!driving) return
    e.preventDefault()
    const text = type === 'keyDown' ? textOf(e) : undefined
    send({
      _tag: 'key',
      type,
      key: e.key.slice(0, 32),
      code: e.code.slice(0, 32),
      ...(text === undefined ? {} : { text }),
      keyCode: Math.min(255, Math.max(0, e.keyCode)),
      modifiers: modifiersOf(e)
    })
  }

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border bg-black"
      style={{ aspectRatio: size === null ? '16 / 9' : `${size.width} / ${size.height}` }}
    >
      <img
        ref={imgRef}
        alt="The agent's browser"
        className="block h-full w-full object-contain select-none"
        draggable={false}
      />
      <div
        ref={overlayRef}
        role="application"
        aria-label={driving ? 'You are driving the browser' : 'Browser live view'}
        tabIndex={driving ? 0 : -1}
        className={
          driving
            ? 'absolute inset-0 cursor-crosshair outline-none ring-2 ring-amber-400 ring-inset'
            : 'absolute inset-0'
        }
        onMouseDown={(e) => handleMouse('mousePressed', e)}
        onMouseUp={(e) => handleMouse('mouseReleased', e)}
        onMouseMove={(e) => handleMouse('mouseMoved', e)}
        onWheel={onWheel}
        onKeyDown={(e) => handleKey('keyDown', e)}
        onKeyUp={(e) => handleKey('keyUp', e)}
        onContextMenu={(e) => {
          if (driving) e.preventDefault()
        }}
      />
      {driving ? (
        <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-amber-400 px-2.5 py-1 text-xs font-medium text-black shadow">
          <HandIcon className="size-3.5" />
          you are driving
        </div>
      ) : null}
    </div>
  )
}

function OutputGallery({ agentId }: { agentId: AgentId }) {
  const files = useAgentFiles(agentId, BROWSER_OUTPUT_DIR)
  const entries = [...(files.data?.items ?? [])]
    .filter((entry): entry is FileEntry => entry.kind === 'file')
    .sort((a, b) => b.modifiedAt.epochMillis - a.modifiedAt.epochMillis)
    .slice(0, 24)
  const isImage = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path)
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1)

  return (
    <SettingsSection
      title="What it saved"
      description="Screenshots and traces the agent wrote under .taut/browser/out, newest first."
    >
      {entries.length === 0 ? (
        <EmptyState
          icon={<ImageIcon className="size-5" />}
          title="No screenshots yet"
          description="Files the agent's browser tools save show up here."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {entries.map((entry) => (
            <li key={entry.path} className="min-w-0 overflow-hidden rounded-lg border">
              <a
                href={agentFileUrl(agentId, entry.path)}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                {isImage(entry.path) ? (
                  <img
                    src={agentFileUrl(agentId, entry.path)}
                    alt={name(entry.path)}
                    loading="lazy"
                    className="aspect-video w-full bg-muted object-cover"
                  />
                ) : (
                  <div className="flex aspect-video items-center justify-center bg-muted text-xs text-muted-foreground">
                    {name(entry.path).split('.').pop()?.toUpperCase() ?? 'file'}
                  </div>
                )}
              </a>
              <div className="px-2 py-1.5">
                <p className="truncate font-mono text-[11px]">{name(entry.path)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatBytes(entry.size)} · {formatRelative(entry.modifiedAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}

export function AgentWorkspaceBrowser({
  agent,
  socket,
  canManage
}: {
  agent: Agent
  /** `null` until Connect. */
  socket: WorkspaceSocket | null
  canManage: boolean
}) {
  const me = useMe().data?.user.id
  const presence = usePresence(agent.id, 'idle')
  const updateAgent = useUpdateAgent()
  // State scoped to one socket: a different socket reads as fresh (derived, so no
  // reset inside the effect), the effect only subscribes.
  const [session, setSession] = React.useState<{
    socket: WorkspaceSocket | null
    browser: BrowserState | null
    control: ControlState
  }>({ socket: null, browser: null, control: NOBODY })
  const browser = session.socket === socket ? session.browser : null
  const control = session.socket === socket ? session.control : NOBODY
  const [confirmPause, setConfirmPause] = React.useState(false)

  React.useEffect(() => {
    if (socket === null) return
    const offBrowser = socket.on('browser', (frame) =>
      setSession((prev) => ({
        socket,
        browser: frame,
        control: prev.socket === socket ? prev.control : NOBODY
      }))
    )
    const offControl = socket.on('control', (frame) =>
      setSession((prev) => ({
        socket,
        browser: prev.socket === socket ? prev.browser : null,
        control: frame
      }))
    )
    const offState = socket.onState((state) => {
      if (state === 'closed') setSession({ socket: null, browser: null, control: NOBODY })
    })
    return () => {
      offBrowser()
      offControl()
      offState()
    }
  }, [socket])

  const driving = control.holder !== null && control.holder === me
  const someoneElse = control.holder !== null && control.holder !== me
  const working = presence === 'working'
  const live = socket !== null && browser?.state === 'live'

  const take = (pause: boolean) => socket?.send({ _tag: 'control', hold: true, pause })
  const release = () => socket?.send({ _tag: 'control', hold: false })

  const controlButton = !live ? null : driving ? (
    <Button size="sm" variant="outline" onClick={release}>
      <HandIcon />
      Release control
    </Button>
  ) : someoneElse ? (
    <Button size="sm" variant="outline" disabled>
      Someone else is driving
    </Button>
  ) : working ? (
    <Button size="sm" variant="outline" onClick={() => setConfirmPause(true)}>
      <PauseIcon />
      Pause agent &amp; take control
    </Button>
  ) : (
    <Button size="sm" variant="outline" onClick={() => take(false)}>
      <HandIcon />
      Take control
    </Button>
  )

  return (
    <>
      <SettingsSection
        title="Browser"
        description={
          agent.browserAccess
            ? 'A live view of the headless Chromium in the box. Take control to log a site in by hand; it sticks in the agent’s profile.'
            : 'This agent has no browser.'
        }
        action={
          <div className="flex items-center gap-2">
            {control.paused ? <Badge variant="outline">agent paused</Badge> : null}
            {controlButton}
          </div>
        }
      >
        {!agent.browserAccess ? (
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <GlobeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Browser access is off</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Turn it on to give the agent a headless Chromium and this live view of it. Same
                switch as the Runtime tab.
              </p>
            </div>
            <Switch
              checked={false}
              disabled={!canManage || updateAgent.isPending}
              aria-label="Browser access"
              onCheckedChange={(next) => {
                if (next) updateAgent.mutate({ agentId: agent.id, browserAccess: true })
              }}
            />
          </div>
        ) : socket === null ? (
          <EmptyState
            icon={<GlobeIcon className="size-5" />}
            title="Not connected"
            description="Connect to the box above to watch its browser."
          />
        ) : (
          <div className="grid gap-2">
            {browser === null || browser.state === 'starting' ? (
              <p className="text-xs text-muted-foreground">Starting the browser in the box…</p>
            ) : browser.state === 'unavailable' ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
                Live view unavailable{browser.reason ? `: ${browser.reason}` : '.'}
              </p>
            ) : browser.state === 'off' ? (
              <p className="text-xs text-muted-foreground">The live view is off for this agent.</p>
            ) : null}
            {control.reason ? (
              <p className="text-xs text-muted-foreground">{control.reason}</p>
            ) : null}
            {live ? <LiveView socket={socket} driving={driving} /> : null}
            {someoneElse ? (
              <p className="text-xs text-muted-foreground">
                Another manager is driving this browser right now.
              </p>
            ) : null}
          </div>
        )}
      </SettingsSection>

      {agent.browserAccess ? <OutputGallery agentId={agent.id} /> : null}

      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title="Pause the agent and take control?"
        confirmLabel="Pause & take control"
        description={
          <p>
            The agent is in the middle of a task. Its runtime is frozen while you drive and resumes
            the moment you release control, disconnect, or go idle. A task paused for a long time
            may hit its own time limit.
          </p>
        }
        onConfirm={() => {
          take(true)
          setConfirmPause(false)
        }}
      />
    </>
  )
}
