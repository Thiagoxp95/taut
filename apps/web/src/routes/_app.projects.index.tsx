import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  CircleIcon,
  ExternalLinkIcon,
  ListIcon,
  RefreshCwIcon,
  SquareKanbanIcon,
  TriangleAlertIcon
} from 'lucide-react'
import type { Project } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Skeleton } from '@taut/ui/components/skeleton'
import { cn } from '@taut/ui/lib/utils'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { ProjectBoard } from '@/components/project-board'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import { SettingsCallout } from '@/components/settings'
import {
  SYNC_STALE_MS,
  useCanAdminister,
  useLinearConnection,
  useProjects,
  useSyncProjects
} from '@/lib/api'
import { formatRelative } from '@/lib/format'
import {
  PROJECT_STATE_COLOR,
  PROJECT_STATE_LABEL,
  formatTimelessDate,
  projectProgress
} from '@/lib/projects'

/** `board` or `list`, remembered per browser. The board is what `/projects` opens on. */
type View = 'board' | 'list'
const VIEW_KEY = 'taut.projects.view'

function useProjectView(): [View, (view: View) => void] {
  const [view, setView] = React.useState<View>(() =>
    globalThis.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'
  )
  return [
    view,
    (next) => {
      setView(next)
      globalThis.localStorage?.setItem(VIEW_KEY, next)
    }
  ]
}

function ProjectRow({ project }: { project: Project }) {
  const progress = projectProgress(project)
  const target = formatTimelessDate(project.targetDate)

  return (
    <li>
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
      >
        <CircleIcon className={cn('size-3 shrink-0', PROJECT_STATE_COLOR[project.state])} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{project.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {project.description ?? PROJECT_STATE_LABEL[project.state]}
          </p>
        </div>
        <ProjectPriorityIcon priority={project.priority} className="hidden sm:block" />
        {project.teams.length === 0 ? null : (
          <Badge variant="outline" className="hidden font-normal sm:inline-flex">
            {project.teams.map((team) => team.key).join(' · ')}
          </Badge>
        )}
        {target === undefined ? null : (
          <span className="hidden text-xs whitespace-nowrap text-muted-foreground md:block">
            {target}
          </span>
        )}
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {progress}%
        </span>
      </Link>
    </li>
  )
}

function ProjectsRoute() {
  const connection = useLinearConnection()
  const projects = useProjects()
  const sync = useSyncProjects()
  const canAdminister = useCanAdminister()

  const [filter, setFilter] = React.useState('')
  const [view, setView] = useProjectView()

  const connected = connection.data?.state === 'connected'
  const lastSyncedAt = connection.data?.lastSyncedAt
  const lastError = connection.data?.lastSyncError

  /**
   * D5: the page is the sync trigger. It fires once per mount, only when the
   * mirror is older than `SYNC_STALE_MS`, and only for someone allowed to sync —
   * a member opening the page reads whatever the last admin pulled.
   */
  const syncing = sync.isPending
  React.useEffect(() => {
    if (!connected || !canAdminister || syncing) return
    const age =
      lastSyncedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - lastSyncedAt.epochMillis
    if (age < SYNC_STALE_MS) return
    sync.mutate()
    // Mount-and-connection scoped on purpose: re-running on every `sync` identity
    // change would loop the mutation against itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, canAdminister])

  const needle = filter.trim().toLowerCase()
  const items = (projects.data?.items ?? []).filter(
    (project) => needle === '' || project.name.toLowerCase().includes(needle)
  )

  return (
    <>
      <PageHeader
        title="Projects"
        description={
          lastSyncedAt === undefined
            ? 'Mirrored from Linear.'
            : `Mirrored from Linear · synced ${formatRelative(lastSyncedAt)}`
        }
        icon={<SquareKanbanIcon className="size-4" />}
        actions={
          connected ? (
            <>
              <div className="hidden items-center rounded-md border p-0.5 sm:flex">
                <Button
                  variant={view === 'board' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2"
                  aria-pressed={view === 'board'}
                  onClick={() => setView('board')}
                >
                  <SquareKanbanIcon />
                  Board
                </Button>
                <Button
                  variant={view === 'list' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2"
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                >
                  <ListIcon />
                  List
                </Button>
              </div>
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter projects"
                aria-label="Filter projects"
                className="hidden h-8 w-48 text-xs sm:block"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!canAdminister || sync.isPending}
                onClick={() => sync.mutate()}
              >
                <RefreshCwIcon className={sync.isPending ? 'animate-spin' : undefined} />
                {sync.isPending ? 'Syncing…' : 'Refresh'}
              </Button>
            </>
          ) : null
        }
      />
      <PageBody
        className={
          view === 'board' && connected
            ? 'flex min-h-0 flex-col overflow-hidden pr-2 pb-4'
            : undefined
        }
      >
        {lastError === undefined ? null : (
          <SettingsCallout
            variant="attention"
            icon={<TriangleAlertIcon />}
            title="The last sync failed"
            description={`${lastError} What you see below is the last version Taut managed to read.`}
          />
        )}

        {connection.isPending || projects.isPending ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : !connected ? (
          <EmptyState
            icon={<SquareKanbanIcon className="size-5" />}
            title="Linear is not connected"
            description={
              canAdminister
                ? 'Projects are mirrored from a Linear workspace. Connect one and they appear here and in the sidebar.'
                : 'Projects are mirrored from Linear. An owner or an admin connects the workspace.'
            }
            action={
              canAdminister ? (
                <Button asChild size="sm">
                  <Link to="/settings/linear">Connect Linear</Link>
                </Button>
              ) : undefined
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<SquareKanbanIcon className="size-5" />}
            title={needle === '' ? 'No projects yet' : `Nothing matches "${filter.trim()}"`}
            description={
              needle === ''
                ? 'This Linear workspace has no projects the key can see. Create one in Linear and refresh.'
                : 'Clear the filter to see everything mirrored from Linear.'
            }
          />
        ) : view === 'board' ? (
          <ProjectBoard projects={items} canMove={canAdminister} />
        ) : (
          <section className="overflow-hidden rounded-xl border bg-card">
            <ul className="divide-y">
              {items.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </ul>
          </section>
        )}

        {!connected || view === 'board' ? null : (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ExternalLinkIcon className="size-3" />
            Projects are read-only in Taut. Change one in Linear and refresh.
          </p>
        )}
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/projects/')({
  component: ProjectsRoute
})
