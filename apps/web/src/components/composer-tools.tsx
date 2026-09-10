import * as React from 'react'
import type { Agent } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { cn } from '@taut/ui/lib/utils'
import { RunControls } from '@/components/run-controls'
import type { RunOverrideState } from '@/hooks/use-run-override'

/** Keep the text tools secondary whenever the draft addresses an agent. */
export function ComposerTools({
  agent,
  state,
  disabled,
  children
}: {
  readonly agent: Agent | undefined
  readonly state: RunOverrideState
  readonly disabled: boolean
  readonly children: React.ReactNode
}) {
  const agentMode = agent !== undefined
  const [mode, setMode] = React.useState(agentMode)
  const [expanded, setExpanded] = React.useState(!agentMode)
  const [lastAgent, setLastAgent] = React.useState(agent)
  const id = React.useId()
  const railRef = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ start: false, end: false })

  // Reset the disclosure on a change of audience, not on every keystroke.
  // Retain the previous agent long enough for the controls to fold away.
  if (mode !== agentMode) {
    setMode(agentMode)
    setExpanded(!agentMode)
  }
  if (agent !== undefined && agent !== lastAgent) setLastAgent(agent)

  const updateEdges = React.useCallback(() => {
    const rail = railRef.current
    if (rail === null) return
    const start = rail.scrollLeft > 1
    const end = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1
    setEdges((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end }
    )
  }, [])

  React.useEffect(() => {
    const rail = railRef.current
    if (rail === null) return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(rail)
    updateEdges()
    return () => observer.disconnect()
  }, [updateEdges])

  return (
    <div className="taut-composer-tools" data-agent={agentMode}>
      <div className="taut-composer-agent" inert={!agentMode} aria-hidden={!agentMode}>
        <div className="taut-composer-agent-content">
          {lastAgent === undefined ? null : (
            <RunControls
              agent={agent ?? lastAgent}
              state={state}
              disabled={disabled || !agentMode}
            />
          )}
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={expanded ? 'Hide formatting' : 'Show formatting'}
        title={expanded ? 'Hide formatting' : 'Show formatting'}
        aria-expanded={expanded}
        aria-controls={id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          'shrink-0 text-muted-foreground transition-colors',
          expanded && 'bg-accent/60 text-foreground'
        )}
      >
        <span aria-hidden className="text-[15px] font-medium tracking-tight">
          Aa
        </span>
      </Button>

      <div
        id={id}
        className="taut-composer-formats"
        data-expanded={expanded}
        data-fade-start={edges.start}
        data-fade-end={edges.end}
        inert={!expanded}
        aria-hidden={!expanded}
      >
        <div
          ref={railRef}
          role="group"
          aria-label="Text formatting"
          onScroll={updateEdges}
          // `py-1` keeps a focus ring off the scroll container's clip edge;
          // `-my-1` hands that height back so the rail never makes the footer
          // row taller than a button and eats into the composer's bottom gap.
          className="taut-rail -my-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 py-1"
        >
          {children}
        </div>
      </div>
    </div>
  )
}
