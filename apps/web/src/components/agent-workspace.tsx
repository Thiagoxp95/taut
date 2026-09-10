/**
 * The Workspace tab (docs/build-plan-workspace.md D1, D2, D5): the machine card
 * with Connect driven by `MachineInfo.status`, then the three panes — Terminal
 * (lazy, D14), Browser, Processes — over one `WorkspaceSocket`. `Files` stays its
 * own tab; this one links to it.
 *
 * On the `local` provider there is no shell (D2): a PTY there would be a shell on the
 * owner's own machine, not on an agent's box. The browser is a different story — it is
 * a Chromium Taut starts on the agent's own profile — so that provider still gets the
 * machine card and the Browser pane, over a browser-only socket (`pty=0`).
 */
import * as React from 'react'
import { FolderIcon, PlugIcon, PowerIcon, ServerIcon, SquareIcon } from '@taut/ui/components/icons'
import type { Agent, AgentId, MachineInfo } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { toast } from '@taut/ui/components/sonner'

import { AgentWorkspaceBrowser } from '@/components/agent-workspace-browser'
import { AgentWorkspaceProcesses } from '@/components/agent-workspace-processes'
import { SettingsSection } from '@/components/settings'
import {
  WorkspaceSocket,
  terminalSocketUrl,
  useMachineInfo,
  useStartMachine,
  useStopMachine,
  type SocketState
} from '@/lib/workspace'

/** D14: xterm.js is a separate chunk, fetched the first time a terminal is shown. */
const AgentWorkspaceTerminal = React.lazy(() => import('@/components/agent-workspace-terminal'))

const STATUS_LABEL: Record<MachineInfo['status'], string> = {
  missing: 'not created',
  creating: 'creating',
  running: 'running',
  stopped: 'stopped'
}

/**
 * Why there is no shell here (D2). Shown in place of the Terminal pane on the `local`
 * provider; the Browser pane below it still works.
 */
function NoTerminalExplainer({ onFiles }: { onFiles?: () => void }) {
  return (
    <SettingsSection
      title="Terminal"
      description="Not on this provider — the browser below still works."
    >
      <div className="flex items-start gap-3 rounded-lg border p-4">
        <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">No shell on the local provider</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This instance runs agents with the <code className="font-mono">local</code> provider:
            they spawn on the host machine itself, so there is no isolated box to open a terminal in
            — a shell here would be a shell on that host. Switch to the{' '}
            <code className="font-mono">docker</code> provider (
            <code className="font-mono">TAUT_MACHINE_PROVIDER=docker</code>) for one hardened
            container per agent with a terminal and a process list.
          </p>
          {onFiles ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={onFiles}>
              <FolderIcon />
              Open the Files tab
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  )
}

/** The provider gives this agent neither a shell nor a browser: nothing to show. */
function NoWorkspace({ onFiles }: { onFiles?: () => void }) {
  return (
    <SettingsSection
      title="Workspace"
      description="Terminal, processes and browser of the agent's box."
    >
      <div className="flex items-start gap-3 rounded-lg border p-4">
        <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">No workspace on this provider</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This instance&rsquo;s machine provider gives the agent neither a terminal nor a browser
            to watch.
          </p>
          {onFiles ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={onFiles}>
              <FolderIcon />
              Open the Files tab
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  )
}

function MachineCard({
  agentId,
  machine,
  socketState,
  onConnect,
  onDisconnect
}: {
  agentId: AgentId
  machine: MachineInfo
  socketState: SocketState | null
  onConnect: () => void
  onDisconnect: () => void
}) {
  /** Without a terminal the only thing Connect opens is the browser; say so. */
  const connectLabel = machine.terminal ? 'Connect' : 'Watch the browser'
  const start = useStartMachine()
  const stop = useStopMachine()
  const connected = socketState === 'open' || socketState === 'connecting'
  const running = machine.status === 'running'

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          Machine{' '}
          <Badge variant={running ? 'default' : 'outline'} className="ml-1 align-middle">
            {STATUS_LABEL[machine.status]}
          </Badge>
        </p>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {machine.machineId ?? 'no container yet'}
          {machine.image ? ` · ${machine.image}` : ''}
          {machine.home ? ` · home ${machine.home}` : ''}
        </p>
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&>button]:max-w-full [&>button]:whitespace-normal">
        {running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={stop.isPending || connected}
            onClick={() => stop.mutate({ agentId })}
          >
            <SquareIcon />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                { agentId },
                { onError: (error) => toast.error(`Could not start the box: ${error.message}`) }
              )
            }
          >
            <PowerIcon />
            {start.isPending ? 'Starting…' : 'Start'}
          </Button>
        )}
        {connected ? (
          <Button size="sm" variant="outline" onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={start.isPending}
            onClick={() => {
              if (running) return onConnect()
              start.mutate(
                { agentId },
                {
                  onSuccess: onConnect,
                  onError: (error) => toast.error(`Could not start the box: ${error.message}`)
                }
              )
            }}
          >
            <PlugIcon />
            {running ? connectLabel : `Start & ${connectLabel.toLowerCase()}`}
          </Button>
        )}
      </div>
    </div>
  )
}

export function AgentWorkspaceTab({
  agent,
  canManage,
  onFiles
}: {
  agent: Agent
  canManage: boolean
  /** Switches to the Files tab (D1: the tree lives there, never here). */
  onFiles?: () => void
}) {
  const machine = useMachineInfo(agent.id)
  const [socket, setSocket] = React.useState<WorkspaceSocket | null>(null)
  const [socketState, setSocketState] = React.useState<SocketState | null>(null)
  const geometry = React.useRef({ cols: 100, rows: 30 })
  const onGeometry = React.useCallback((cols: number, rows: number) => {
    geometry.current = { cols, rows }
  }, [])

  const wantsPty = machine.data?.terminal === true

  const connect = React.useCallback(() => {
    // The socket is opened *here*, never inside the state updater: React invokes an
    // updater twice in development, which opened two sockets and let the server refuse
    // the second one ("you already have a terminal open on this agent") while the tab
    // waited on it forever.
    const next = new WorkspaceSocket(
      terminalSocketUrl(agent.id, geometry.current.cols, geometry.current.rows, {
        pty: wantsPty
      })
    )
    setSocketState('connecting')
    next.onState((state, closed) => {
      setSocketState(state)
      if (state === 'closed' && closed !== undefined && closed.code !== 1000) {
        toast.error(closed.reason || `Terminal closed (${closed.code})`)
      }
    })
    setSocket((current) => {
      current?.close()
      return next
    })
  }, [agent.id, wantsPty])

  const disconnect = React.useCallback(() => {
    setSocket((current) => {
      current?.close()
      return null
    })
    setSocketState(null)
  }, [])

  // Leaving the tab (or the page) closes the socket: the box must not keep a PTY for nobody.
  React.useEffect(() => () => socket?.close(), [socket])

  if (machine.isPending) return <Skeleton className="h-40 rounded-lg" />
  if (machine.isError || machine.data === undefined) {
    return (
      <SettingsSection
        title="Workspace"
        description="Terminal, processes and browser of the agent's box."
      >
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          Could not read the machine: {machine.error?.message ?? 'unknown error'}
        </p>
      </SettingsSection>
    )
  }
  const terminal = machine.data.terminal
  if (!terminal && !machine.data.liveView) return <NoWorkspace onFiles={onFiles} />

  return (
    <>
      <SettingsSection
        title="Workspace"
        description={
          terminal
            ? "The agent's box: a terminal in it, what runs in it, and its browser. Files have their own tab."
            : "The agent's browser: watch it, or take the keyboard. Files have their own tab."
        }
        action={
          onFiles ? (
            <Button size="sm" variant="ghost" onClick={onFiles}>
              <FolderIcon />
              Files
            </Button>
          ) : null
        }
      >
        <MachineCard
          agentId={agent.id}
          machine={machine.data}
          socketState={socketState}
          onConnect={connect}
          onDisconnect={disconnect}
        />
      </SettingsSection>

      {terminal ? (
        <SettingsSection
          title="Terminal"
          description="A login shell as the agent, in its home. Closes after 15 minutes without activity."
        >
          {socket === null ? (
            <div className="flex h-40 items-center justify-center rounded-lg border bg-[#0b0f14] text-xs text-zinc-400">
              Connect to open a shell in the box.
            </div>
          ) : (
            <React.Suspense fallback={<Skeleton className="h-[26rem] rounded-lg" />}>
              <AgentWorkspaceTerminal socket={socket} onGeometry={onGeometry} />
            </React.Suspense>
          )}
        </SettingsSection>
      ) : (
        <NoTerminalExplainer onFiles={onFiles} />
      )}

      <AgentWorkspaceBrowser agent={agent} socket={socket} canManage={canManage} />
      {terminal ? <AgentWorkspaceProcesses agentId={agent.id} machine={machine.data} /> : null}
    </>
  )
}
