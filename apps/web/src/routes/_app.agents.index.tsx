import { Link, createFileRoute } from '@tanstack/react-router'
import { BotIcon, CreditCardIcon, PlusIcon } from 'lucide-react'
import type { Agent } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { EntityAvatar } from '@/components/entity-avatar'
import { PresenceDot, presenceLabel } from '@/components/presence-dot'
import { useAgentDepartments, useDepartmentShapes } from '@/hooks/use-directory'
import { useAgents, useCanAdminister, useSubscriptions } from '@/lib/api'
import { formatRelative } from '@/lib/format'
import { agentFace } from '@/lib/agent-avatar'
import { usePresence } from '@/lib/live'
import { RUNTIME_LABELS } from '@/lib/runtime-meta'

/** Mandate markdown collapsed to one readable paragraph for the card. */
function mandatePreview(mandate: string): string {
  return mandate
    .replace(/^#.*\n+/, '')
    .replace(/[#*`>-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function AgentCard({ agent }: { agent: Agent }) {
  const presence = usePresence(agent.id, 'idle')
  const departments = useAgentDepartments(agent)
  const shapes = useDepartmentShapes()

  return (
    <Link
      to="/agents/$agentId"
      params={{ agentId: agent.id }}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground transition-colors outline-none hover:border-ring/50 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <EntityAvatar kind="agent" face={agentFace(agent, shapes)} name={agent.name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {agent.name} <span className="font-normal text-muted-foreground">@{agent.handle}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">{agent.role || 'No role set'}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <PresenceDot presence={presence} />
          {presenceLabel(presence)}
        </span>
      </div>

      {departments.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {departments.map((department) => (
            <span
              key={department.id}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {department.name}
            </span>
          ))}
        </div>
      )}

      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {mandatePreview(agent.mandate) || 'No mandate yet.'}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{RUNTIME_LABELS[agent.runtimeKind]}</Badge>
        <Badge variant="outline">{agent.permissionMode}</Badge>
        {agent.archivedAt === undefined ? (
          <Badge variant={agent.status === 'active' ? 'secondary' : 'outline'}>
            {agent.status}
          </Badge>
        ) : (
          <Badge variant="outline">archived</Badge>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          updated {formatRelative(agent.updatedAt)}
        </span>
      </div>
    </Link>
  )
}

function AgentsRoute() {
  const query = useAgents()
  const subscriptions = useSubscriptions()
  const canAdminister = useCanAdminister()
  // Archived agents keep their card — their work is still readable — but they sink to the
  // bottom of the grid, behind everyone who still answers.
  const agents = [...(query.data?.items ?? [])].sort(
    (a, b) => Number(a.archivedAt !== undefined) - Number(b.archivedAt !== undefined)
  )

  const noPool = !subscriptions.isPending && (subscriptions.data?.items ?? []).length === 0

  return (
    <>
      <PageHeader
        title="Agents"
        description="Members that run on the company's subscription pool."
        icon={<BotIcon className="size-4" />}
        actions={
          <Button asChild size="sm">
            <Link to="/agents/new">
              <PlusIcon />
              New agent
            </Link>
          </Button>
        }
      />
      <PageBody>
        {noPool && canAdminister ? (
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <CreditCardIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <p className="min-w-0 flex-1 text-muted-foreground">
              The subscription pool is empty, so no agent can run a task yet.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to="/subscriptions">Connect a runtime</Link>
            </Button>
          </div>
        ) : null}

        {query.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <EmptyState
            icon={<BotIcon className="size-5" />}
            title="No agents yet"
            description="An agent is a handle, a mandate, and a runtime seat. Create one and @mention it in a channel."
            action={
              <Button asChild size="sm">
                <Link to="/agents/new">Create your first agent</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/agents/')({
  component: AgentsRoute
})
