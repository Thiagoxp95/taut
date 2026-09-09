/**
 * The Processes pane (docs/build-plan-workspace.md D13): `ps` inside the box,
 * refreshed every 3 s — only while the pane is on screen (an `IntersectionObserver`
 * gates the query) and the tab is in the foreground (TanStack's own background
 * pause). Read-only by decision: no kill button (`// TODO(plan)`), because killing
 * a runtime mid-task would corrupt the task and its handover.
 */
import * as React from 'react'
import { ActivityIcon } from 'lucide-react'
import type { AgentId, MachineInfo, ProcessEntry } from '@taut/contract'
import { Skeleton } from '@taut/ui/components/skeleton'

import { EmptyState } from '@/components/page'
import { SettingsSection } from '@/components/settings'
import { useProcesses } from '@/lib/workspace'

const elapsed = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h < 24 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** `true` while `ref`'s element intersects the viewport. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = React.useState(false)
  React.useEffect(() => {
    const element = ref.current
    if (element === null || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return visible
}

export function AgentWorkspaceProcesses({
  agentId,
  machine
}: {
  agentId: AgentId
  machine: MachineInfo
}) {
  const sectionRef = React.useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(sectionRef)
  const running = machine.status === 'running'
  const processes = useProcesses(agentId, running && onScreen)
  const rows: ReadonlyArray<ProcessEntry> = processes.data ?? []

  return (
    <div ref={sectionRef}>
      <SettingsSection
        title="Processes"
        description={
          running
            ? 'What is running in the box right now, refreshed every 3 seconds while this is on screen.'
            : 'Start the box to see what runs in it.'
        }
      >
        {!running ? (
          <EmptyState
            icon={<ActivityIcon className="size-5" />}
            title="The box is not running"
            description="Processes appear once the machine is started."
          />
        ) : processes.isPending ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ActivityIcon className="size-5" />}
            title="Nothing but the box itself"
            description="No agent process is running right now."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">PID</th>
                  <th className="px-3 py-2 font-medium">PPID</th>
                  <th className="px-3 py-2 font-medium">Up</th>
                  <th className="px-3 py-2 text-right font-medium">CPU %</th>
                  <th className="px-3 py-2 text-right font-medium">Mem %</th>
                  <th className="px-3 py-2 font-medium">Command</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((p) => (
                  <tr key={p.pid} className="align-top">
                    <td className="px-3 py-1.5 font-mono tabular-nums">{p.pid}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground tabular-nums">
                      {p.ppid}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums">
                      {elapsed(p.elapsedSeconds)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {p.cpuPercent.toFixed(1)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {p.memoryPercent.toFixed(1)}
                    </td>
                    <td className="max-w-[28rem] px-3 py-1.5 font-mono break-all">{p.command}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* TODO(plan): no kill button (D13) — a runtime killed mid-task corrupts the task and its handover. */}
      </SettingsSection>
    </div>
  )
}
