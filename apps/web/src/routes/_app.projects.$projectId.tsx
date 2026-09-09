import * as React from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LayersIcon,
  SquareKanbanIcon,
  SquarePenIcon,
  UsersIcon
} from 'lucide-react'
import type { Project, ProjectMilestone } from '@taut/contract'
import { ProjectId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { cn } from '@taut/ui/lib/utils'
import { EmptyState, PageHeader } from '@/components/page'
import { Markdown } from '@/components/markdown'
import { ProjectLeadAvatar } from '@/components/project-lead-avatar'
import { ProjectMilestoneIcon } from '@/components/project-milestone-icon'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import { ProjectIssues } from '@/components/project-issues'
import { ProjectStatusIcon } from '@/components/project-status-icon'
import { useProject, useProjectIssues } from '@/lib/api'
import { useEmoji } from '@/lib/emoji'
import { formatRelative } from '@/lib/format'
import {
  PROJECT_HEALTH_COLOR,
  PROJECT_HEALTH_LABEL,
  PROJECT_PRIORITY_LABEL,
  PROJECT_STATE_LABEL,
  formatBoardDate,
  isOverdue,
  projectProgress
} from '@/lib/projects'

/**
 * A project the way Linear draws one (docs/build-plan-projects.md D17).
 *
 * The measurements here are Linear's own, taken off its project overview rather
 * than invented, and written as exact pixels for the same reason the board is
 * (`components/project-board.tsx`): a 92px label gutter, 13px properties on a
 * 28px row, a 30px title, a 15px body on a 24px line, and a content column
 * inset 52px inside 848px. Rounding those to the nearest utility class is what
 * makes a copy look like an imitation.
 *
 * What is *not* copied is the interaction. Linear's chips are editors and its
 * empty slots are invitations; Taut's mirror decides nothing about a project
 * (D1), so every one of those slots either shows something the mirror really
 * holds or hands the reader to Linear, where the change can actually be made.
 * The overflow chip is the exception that stays local: it opens the properties
 * Linear keeps for its own sidebar — health, progress, issue count, last sync.
 */

/** Linear's start-date glyph: a calendar the date arrives into. */
function StartDateIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('size-3.5 shrink-0 text-muted-foreground', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M9.4 2.4h2.7a1.5 1.5 0 0 1 1.5 1.5v8.2a1.5 1.5 0 0 1-1.5 1.5H9.4" />
      <path d="M7.3 5.6 9.7 8l-2.4 2.4" />
      <path d="M9.4 8H2.6" />
    </svg>
  )
}

/** Linear's target-date glyph: a calendar with a date still to be added. */
function TargetDateIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('size-3.5 shrink-0 text-muted-foreground', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M6.6 2.4H3.9a1.5 1.5 0 0 0-1.5 1.5v8.2a1.5 1.5 0 0 0 1.5 1.5h2.7" />
      <path d="M11 5.7v4.6M8.7 8h4.6" />
    </svg>
  )
}

/**
 * One slot in the properties row. Sized to Linear's 28px chip whether it holds a
 * value or a placeholder, so the row keeps its rhythm on a project that has
 * neither lead nor dates.
 */
function Chip({
  children,
  muted = false,
  className
}: {
  children: React.ReactNode
  muted?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] whitespace-nowrap',
        muted && 'text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  )
}

/** `Properties` / `Resources`: the 92px gutter every row on the overview hangs off. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start">
      <span className="mt-[7px] w-[92px] shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <div className="-ml-1.5 flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {children}
      </div>
    </div>
  )
}

/** The properties Linear keeps in its sidebar, behind the row's `···`. */
function MoreProperties({ project }: { project: Project }) {
  const progress = projectProgress(project)
  const facts: ReadonlyArray<readonly [string, React.ReactNode]> = [
    [
      'Health',
      project.health === undefined ? (
        <span key="health" className="text-muted-foreground">
          No update yet
        </span>
      ) : (
        <span key="health" className={PROJECT_HEALTH_COLOR[project.health]}>
          {PROJECT_HEALTH_LABEL[project.health]}
        </span>
      )
    ],
    ['Progress', <span key="progress" className="tabular-nums">{`${progress}%`}</span>],
    [
      'Issues',
      <span key="issues" className="tabular-nums">
        {`${project.issueCount} ${project.issueCount === 1 ? 'issue' : 'issues'}`}
      </span>
    ],
    [
      'Updated in Linear',
      project.updatedAt === undefined ? '—' : formatRelative(project.updatedAt)
    ],
    ['Last synced', formatRelative(project.syncedAt)]
  ]

  return (
    <dl className="mt-1 grid w-full grid-cols-[92px_1fr] gap-y-1.5 text-[13px]">
      {facts.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/**
 * Linear's tab strip. Overview and Issues are both real here now (D19) — the
 * mirror holds a project's issues as well as its milestones. Activity is the one
 * that still leaves: Taut copies what a project *is*, not the feed of everything
 * that has ever happened to it, so the answer lives in Linear and the tab says so.
 */
function Tabs({
  tab,
  onTab,
  url,
  issueCount
}: {
  tab: TabName
  onTab: (next: TabName) => void
  url: string
  issueCount: number | undefined
}) {
  const base =
    'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors'
  const pill = (active: boolean) =>
    cn(base, active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60')

  return (
    <div className="flex shrink-0 items-center gap-1 px-4 pt-4 pb-2">
      <button type="button" onClick={() => onTab('overview')} className={pill(tab === 'overview')}>
        Overview
      </button>
      <a
        href={`${url}/activity`}
        target="_blank"
        rel="noreferrer"
        className={cn(base, 'group text-muted-foreground hover:bg-accent/60 hover:text-foreground')}
      >
        Activity
        <ExternalLinkIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-70" />
      </a>
      <button type="button" onClick={() => onTab('issues')} className={pill(tab === 'issues')}>
        Issues
        {issueCount === undefined || issueCount === 0 ? null : (
          <span className="text-muted-foreground tabular-nums">{issueCount}</span>
        )}
      </button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title="Open this project in Linear"
        className="ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <LayersIcon className="size-4" />
      </a>
    </div>
  )
}

/** One milestone, drawn as the row Linear puts under a project's description. */
function MilestoneRow({ milestone }: { milestone: ProjectMilestone }) {
  const target = formatBoardDate(milestone.targetDate)
  const overdue = milestone.status !== 'done' && isOverdue(milestone.targetDate)

  return (
    <li className="-mx-2 flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-accent/40">
      <span className="mt-[3px]">
        <ProjectMilestoneIcon status={overdue ? 'overdue' : milestone.status} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-6">{milestone.name}</p>
        {milestone.description === undefined ? null : (
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
            {milestone.description}
          </p>
        )}
      </div>
      {target === undefined ? null : (
        <span
          className={cn(
            'mt-[3px] text-[13px] whitespace-nowrap',
            overdue ? 'text-red-500' : 'text-muted-foreground'
          )}
        >
          {target}
        </span>
      )}
    </li>
  )
}

/** Which tab the route is on. Lives in the URL, so a link to Issues opens on Issues. */
type TabName = 'overview' | 'issues'

function ProjectRoute() {
  const { projectId } = Route.useParams()
  const id = ProjectId.make(projectId)
  const tab: TabName = Route.useSearch().tab ?? 'overview'
  const navigate = Route.useNavigate()
  const query = useProject(id)
  // Only fetched once the tab is opened: the Overview never needs them, and a
  // busy team's project has hundreds (D19).
  const issuesQuery = useProjectIssues(tab === 'issues' ? id : undefined)
  const emoji = useEmoji()
  const [more, setMore] = React.useState(false)

  const detail = query.data
  const project = detail?.project

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Project" icon={<SquareKanbanIcon className="size-4" />} />
        <div className="taut-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[848px] px-[52px] pt-[72px]">
            <Skeleton className="size-9 rounded-[7px]" />
            <Skeleton className="mt-4 h-8 w-2/3" />
            <Skeleton className="mt-3 h-5 w-full" />
            <Skeleton className="mt-2 h-5 w-4/5" />
            <Skeleton className="mt-8 h-7 w-1/2" />
            <Skeleton className="mt-8 h-[68px] w-full rounded-lg" />
          </div>
        </div>
      </>
    )
  }

  if (project === undefined) {
    return (
      <>
        <PageHeader title="Project" icon={<SquareKanbanIcon className="size-4" />} />
        <div className="taut-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <EmptyState
            icon={<SquareKanbanIcon className="size-5" />}
            title="This project is not in the mirror"
            description="It may have been deleted in Linear, or the last sync no longer sees it."
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/projects">Back to projects</Link>
              </Button>
            }
          />
        </div>
      </>
    )
  }

  const glyph = emoji(project.icon)
  const statusName = project.status?.name ?? PROJECT_STATE_LABEL[project.state]
  const start = formatBoardDate(project.startDate)
  const target = formatBoardDate(project.targetDate)
  const milestones = detail?.milestones ?? []

  return (
    <>
      <PageHeader
        title={project.name}
        description={`Mirrored from Linear · synced ${formatRelative(project.syncedAt)}`}
        icon={
          <ProjectStatusIcon
            type={project.status?.type ?? project.state}
            color={project.status?.color}
            className="size-4"
          />
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <a href={project.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Open in Linear
            </a>
          </Button>
        }
      />

      <div className="taut-scroll min-h-0 flex-1 overflow-y-auto">
        <Tabs
          tab={tab}
          onTab={(next) =>
            void navigate({ search: next === 'issues' ? { tab: next } : {}, replace: true })
          }
          url={project.url}
          issueCount={project.issueCount === 0 ? undefined : project.issueCount}
        />

        {tab === 'issues' ? (
          <div className="mx-auto w-full max-w-[1100px] px-6 pt-2 pb-24">
            {issuesQuery.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-9 rounded-md" />
                <Skeleton className="h-11 rounded-md" />
                <Skeleton className="h-11 rounded-md" />
              </div>
            ) : (issuesQuery.data ?? []).length === 0 ? (
              <p className="px-4 py-16 text-center text-[15px] text-muted-foreground">
                No issues in this project&rsquo;s mirror. They arrive on the next sync, and an agent
                can file one for you.
              </p>
            ) : (
              <ProjectIssues issues={issuesQuery.data ?? []} url={project.url} />
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[848px] px-[52px] pt-[60px] pb-24">
            {glyph === undefined ? null : (
              <span
                aria-hidden
                className="mb-4 flex size-9 items-center justify-center rounded-[7px] bg-accent/60 text-[19px] leading-none"
              >
                {glyph}
              </span>
            )}

            <h1 className="text-[30px] leading-[36px] font-semibold tracking-[-0.014em]">
              {project.name}
            </h1>

            {project.description === undefined ? null : (
              <p className="mt-2 max-w-[720px] text-[15px] leading-[24px] text-foreground/80">
                {project.description}
              </p>
            )}

            <div className="mt-6 space-y-0.5">
              <Row label="Properties">
                <Chip>
                  <ProjectStatusIcon
                    type={project.status?.type ?? project.state}
                    color={project.status?.color}
                  />
                  {statusName}
                </Chip>
                <Chip>
                  <ProjectPriorityIcon priority={project.priority} />
                  {project.priorityLabel ?? PROJECT_PRIORITY_LABEL[project.priority]}
                </Chip>
                {project.lead === undefined ? (
                  <Chip muted>
                    <UsersIcon className="size-3.5" />
                    No lead
                  </Chip>
                ) : (
                  <Chip>
                    <ProjectLeadAvatar
                      lead={project.lead}
                      className="size-[18px]"
                      textClassName="text-[9px]"
                    />
                    {project.lead.name}
                  </Chip>
                )}
                <Chip muted={start === undefined}>
                  <StartDateIcon />
                  {start ?? 'Start date'}
                </Chip>
                <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <Chip muted={target === undefined}>
                  <TargetDateIcon />
                  {target ?? 'Target date'}
                </Chip>
                {project.teams.map((team) => (
                  <Chip key={team.key}>
                    <UsersIcon className="size-3.5 text-muted-foreground" />
                    {team.name}
                  </Chip>
                ))}
                <button
                  type="button"
                  onClick={() => setMore((open) => !open)}
                  aria-expanded={more}
                  title={more ? 'Hide the rest' : 'Health, progress, issues, last sync'}
                  className={cn(
                    'flex h-7 shrink-0 items-center rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    more && 'bg-accent/60 text-foreground'
                  )}
                >
                  <EllipsisIcon className="size-4" />
                </button>
                {more ? <MoreProperties project={project} /> : null}
              </Row>

              <Row label="Resources">
                <a
                  href={project.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  <ExternalLinkIcon className="size-3.5" />
                  This project in Linear
                </a>
              </Row>
            </div>

            {project.health === undefined ? (
              <a
                href={project.url}
                target="_blank"
                rel="noreferrer"
                className="mt-6 -mx-4 flex h-[68px] items-center justify-center gap-2.5 rounded-lg border text-[15px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <SquarePenIcon className="size-4" />
                Write first project update
              </a>
            ) : (
              <a
                href={project.url}
                target="_blank"
                rel="noreferrer"
                className="mt-6 -mx-4 flex h-[68px] items-center gap-3 rounded-lg border px-4 transition-colors hover:bg-accent/40"
              >
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full bg-current',
                    PROJECT_HEALTH_COLOR[project.health]
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-[15px] leading-5">
                    {PROJECT_HEALTH_LABEL[project.health]}
                  </span>
                  <span className="block text-[13px] leading-5 text-muted-foreground">
                    {"From Linear's last project update · read the update in Linear"}
                  </span>
                </span>
                <ExternalLinkIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
              </a>
            )}

            <section className="mt-12">
              <h2 className="text-[13px] text-muted-foreground">Description</h2>
              {project.description === undefined ? (
                <p className="mt-5 text-[15px] leading-[24px] text-muted-foreground">
                  Nobody has written one in Linear.
                </p>
              ) : (
                <Markdown
                  source={project.description}
                  className="mt-5 text-[15px] leading-[24px] [&_p]:my-4 [&_p]:first:mt-0"
                />
              )}
            </section>

            <section className="mt-10">
              <h2 className="sr-only">Milestones</h2>
              {milestones.length === 0 ? null : (
                <ul className="mb-1">
                  {milestones.map((milestone) => (
                    <MilestoneRow key={milestone.id} milestone={milestone} />
                  ))}
                </ul>
              )}
              <a
                href={project.url}
                target="_blank"
                rel="noreferrer"
                className="-mx-2 flex h-8 w-fit items-center gap-2 rounded-md px-2 text-[15px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <ProjectMilestoneIcon status={undefined} className="size-3.5" />
                Milestone
              </a>
            </section>
          </div>
        )}
      </div>
    </>
  )
}

export const Route = createFileRoute('/_app/projects/$projectId')({
  // The tab is a search param so it survives a reload and a shared link; anything
  // that is not a tab we have falls back to the Overview rather than erroring.
  validateSearch: (search: Record<string, unknown>): { tab?: TabName } =>
    // Overview leaves the param off entirely, so a plain `/projects/:id` link
    // needs no search of its own and the URL only grows when it says something.
    search['tab'] === 'issues' ? { tab: 'issues' } : {},
  component: ProjectRoute
})
