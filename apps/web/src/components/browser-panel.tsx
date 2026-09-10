import * as React from 'react'
import type { AgentId } from '@taut/contract'
import type { TerminalServerFrame } from '@taut/contract/terminal'
import { Button } from '@taut/ui/components/button'
import { GlobeIcon, HandIcon, PauseIcon, XIcon } from '@taut/ui/components/icons'
import { BrowserInputOverlay } from '@/components/browser-input-overlay'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PaneHandle } from '@/components/pane-layout'
import { useLookupMember } from '@/hooks/use-directory'
import { useBrowserRuns, usePresence, type BrowserRun } from '@/lib/live'
import { connectBrowserPreview } from '@/lib/browser-preview-connection'
import { terminalSocketUrl, WorkspaceSocket } from '@/lib/workspace'

type TabsFrame = Extract<TerminalServerFrame, { _tag: 'tabs' }>
type BrowserFrame = Extract<TerminalServerFrame, { _tag: 'browser' }>

export function useConversationBrowser(channelId: string | undefined, threadId?: string) {
  const runs = useBrowserRuns(channelId, threadId)
  const scope = JSON.stringify([channelId, threadId])
  // Remember browsers only while this conversation is mounted. Task completion
  // clears activity, but must not close the page the user is still looking at.
  const [snapshot, setSnapshot] = React.useState({ scope, source: runs, runs })
  let available = snapshot.runs
  if (snapshot.scope !== scope || snapshot.source !== runs) {
    available = snapshot.scope === scope ? snapshot.runs : []
    for (const run of runs) {
      available = [...available.filter((old) => old.agentId !== run.agentId), run]
    }
    setSnapshot({ scope, source: runs, runs: available })
  }
  const [dismissed, setDismissed] = React.useState<{ scope: string; tasks: readonly string[] }>({
    scope,
    tasks: []
  })
  const active = [...available]
    .reverse()
    .find((run) => dismissed.scope !== scope || !dismissed.tasks.includes(run.taskId))
  const dismiss = () => {
    setDismissed({ scope, tasks: available.map((run) => run.taskId) })
  }
  const show = () => setDismissed({ scope, tasks: [] })
  return { active, runs: available, dismiss, show }
}

/** Follows the agent until this viewer explicitly takes control. No shell is opened. */
function BrowserStream({
  run,
  name,
  onClose
}: {
  run: BrowserRun
  name: string
  onClose: () => void
}) {
  const image = React.useRef<HTMLImageElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const connectionRef = React.useRef<ReturnType<typeof connectBrowserPreview> | null>(null)
  const [control, setControl] = React.useState<Extract<TerminalServerFrame, { _tag: 'control' }>>({
    _tag: 'control',
    holder: null,
    paused: false
  })
  const [confirmPause, setConfirmPause] = React.useState(false)
  const working = usePresence(run.agentId, 'idle') === 'working'
  const driving = control.owned === true
  const occupied = control.holder !== null && !driving
  const take = (pause: boolean) =>
    connectionRef.current?.send({ _tag: 'control', hold: true, pause })
  const [following, setFollowing] = React.useState(true)
  const [tabs, setTabs] = React.useState<TabsFrame | null>(null)
  const [browser, setBrowser] = React.useState<BrowserFrame | null>(null)
  const [error, setError] = React.useState<string>()
  const [received, setReceived] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    let activeTabId: string | null = null
    const connection = connectBrowserPreview(
      () => new WorkspaceSocket(terminalSocketUrl(run.agentId as AgentId, 80, 24, { pty: false })),
      (frame) => {
        switch (frame._tag) {
          case 'control':
            setControl(frame)
            break
          case 'tabs':
            if (frame.activeTabId !== activeTabId) setReceived(false)
            activeTabId = frame.activeTabId
            if (frame.following !== undefined) setFollowing(frame.following)
            setTabs(frame)
            break
          case 'browser':
            setBrowser(frame)
            if (frame.state === 'unavailable') {
              setControl({ _tag: 'control', holder: null, paused: false })
              setConfirmPause(false)
            }
            if (frame.state === 'starting') {
              setError(undefined)
              setReceived(false)
              setTabs(null)
              setFollowing(true)
            }
            break
          case 'error':
            setError(frame.message)
            break
          case 'frame':
            if (image.current) {
              image.current.src = `data:image/jpeg;base64,${frame.data}`
              image.current.style.aspectRatio = `${frame.width} / ${frame.height}`
            }
            setError(undefined)
            setBrowser({ _tag: 'browser', state: 'live' })
            setReceived(true)
            break
        }
      }
    )
    connectionRef.current = connection
    const viewport = viewportRef.current
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width < 1 || height < 1) return
      // Bound oversized windows proportionally, preserving the pane's aspect ratio.
      const scale = Math.min(1, 4096 / width, 4096 / height)
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(
        () =>
          connection.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
          }),
        100
      )
    })
    if (viewport) observer.observe(viewport)
    return () => {
      observer.disconnect()
      clearTimeout(resizeTimer)
      connectionRef.current = null
      connection.close()
    }
  }, [run.agentId, attempt])

  const activeTab = tabs?.tabs.find((tab) => tab.id === tabs.activeTabId)
  const unavailable =
    error ??
    (browser?.state === 'unavailable' ? (browser.reason ?? 'Live view is unavailable.') : undefined)
  const waiting = !received && !unavailable

  return (
    <>
      <header className="taut-topbar flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{name}’s browser</h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            <span className="truncate">
              {driving
                ? 'You are driving'
                : occupied
                  ? 'Controlled in another view'
                  : following
                    ? 'Following agent'
                    : 'Viewing selected tab'}
            </span>
          </p>
        </div>
        {driving ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => connectionRef.current?.send({ _tag: 'control', hold: false })}
          >
            <HandIcon aria-hidden="true" /> Release control
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!received || browser?.state !== 'live' || occupied}
            onClick={() => (working ? setConfirmPause(true) : take(false))}
          >
            {working ? <PauseIcon aria-hidden="true" /> : <HandIcon aria-hidden="true" />}
            Take control
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close browser" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      {tabs && tabs.tabs.length > 0 ? (
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 px-2 pt-2"
          aria-label="Agent browser tabs"
        >
          {tabs.tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() => {
                connectionRef.current?.send({ _tag: 'selectTab', tabId: tab.id })
                setFollowing(false)
              }}
              ref={(element) => {
                if (tab.id === tabs.activeTabId)
                  element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
              }}
              aria-current={tab.id === tabs.activeTabId ? 'page' : undefined}
              title={tab.url}
              className="flex max-w-52 min-w-24 shrink-0 items-center gap-2 rounded-t-md border border-b-0 border-transparent px-3 py-2 text-xs text-muted-foreground aria-[current=page]:border-border aria-[current=page]:bg-background aria-[current=page]:text-foreground cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]"
            >
              <GlobeIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{tab.title || tab.url || 'New tab'}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
        <GlobeIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate" title={activeTab?.url}>
          {activeTab?.url || 'Waiting for a page…'}
        </span>
        {!following ? (
          <Button
            className="ml-auto shrink-0"
            variant="ghost"
            size="sm"
            onClick={() => {
              connectionRef.current?.send({ _tag: 'selectTab', tabId: null })
              setFollowing(true)
            }}
          >
            Follow agent
          </Button>
        ) : null}
      </div>
      {control.reason ? (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {control.reason}
        </p>
      ) : null}
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-muted/20">
        <div className="absolute inset-0" hidden={!received}>
          <img
            ref={image}
            alt={
              activeTab?.title
                ? `Agent browser: ${activeTab.title}`
                : 'Live view of the agent’s browser'
            }
            draggable={false}
            className="block h-full w-full bg-white object-contain"
          />
          <BrowserInputOverlay
            driving={driving && received && browser?.state === 'live'}
            send={(event) => connectionRef.current?.send({ _tag: 'input', event })}
          />
        </div>
        {waiting ? (
          <div
            role="status"
            className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
          >
            <GlobeIcon className="size-6" aria-hidden="true" />
            {browser?.state === 'off'
              ? 'Browser access is off for this agent.'
              : browser?.state === 'live'
                ? 'Loading the agent’s page…'
                : 'Connecting to the agent’s browser…'}
          </div>
        ) : null}
        {unavailable ? (
          <div
            role="status"
            className="relative flex flex-col items-center gap-3 bg-background/90 px-6 py-10 text-center text-sm text-muted-foreground"
          >
            <p>{unavailable}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(undefined)
                setBrowser(null)
                setTabs(null)
                setFollowing(true)
                setReceived(false)
                setAttempt((value) => value + 1)
              }}
            >
              Reconnect
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title="Pause the agent and take control?"
        confirmLabel="Pause & take control"
        description={
          <p>
            The agent pauses while you drive. Release control to let it continue. Closing this pane
            also releases control.
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

export function BrowserPanel({
  run,
  open,
  onClose
}: {
  run: BrowserRun | undefined
  open: boolean
  onClose: () => void
}) {
  const lookup = useLookupMember()
  const panelRef = React.useRef<HTMLElement>(null)
  const close = React.useCallback(() => {
    const trigger = [
      ...(panelRef.current?.parentElement?.querySelectorAll<HTMLElement>(
        '[data-browser-trigger]'
      ) ?? [])
    ].find((element) => element.getClientRects().length > 0)
    onClose()
    trigger?.focus({ preventScroll: true })
  }, [onClose])
  const name = run ? (lookup(run.agentId)?.name ?? 'Agent') : 'Agent'
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  return (
    <aside
      ref={panelRef}
      aria-label="Agent browser"
      aria-hidden={!open}
      inert={!open}
      data-browser-panel="true"
      data-open={open}
      className="taut-canvas-panel flex min-h-0 flex-col bg-background"
    >
      <PaneHandle pane="canvas" label="Resize browser" />

      {open && run ? (
        <BrowserStream key={run.agentId} run={run} name={name} onClose={close} />
      ) : null}
    </aside>
  )
}
