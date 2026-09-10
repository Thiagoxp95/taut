import * as React from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ChevronRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  LinkIcon,
  PlusIcon,
  SquareKanbanIcon,
  Trash2Icon
} from '@taut/ui/components/icons'
import type { Message, ProjectIssue } from '@taut/contract'
// The class, not just the type: an optimistic edit rebuilds the row it is
// changing (docs/build-plan-issues.md D3), the way the message cache does.
import { ProjectIssue as ProjectIssueValue } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@taut/ui/components/dropdown-menu'
import { Skeleton } from '@taut/ui/components/skeleton'
import { toast } from '@taut/ui/components/sonner'
import { cn } from '@taut/ui/lib/utils'
import { Composer } from '@/components/composer'
import { ChannelCanvases, DocumentWorkspace } from '@/components/canvas-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { IssueActivityFeed } from '@/components/issue-activity'
import { IssueAvatar } from '@/components/issue-avatar'
import { IssueCreateDialog } from '@/components/issue-create-dialog'
import { IssuePropertyRail } from '@/components/issue-property-rail'
import { IssueStateIcon } from '@/components/issue-state-icon'
import { Markdown } from '@/components/markdown'
import { EmptyState, PageHeader } from '@/components/page'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import { useChannelGroups } from '@/hooks/use-directory'
import {
  useCanAdminister,
  useDeleteIssue,
  useIssue,
  useIssueActivity,
  useIssueOptions,
  useMessages,
  useMyRole,
  useOpenIssueThread,
  useThread,
  useUpdateIssue
} from '@/lib/api'
import { flattenChannel, flattenThread } from '@/lib/message-cache'

/**
 * One ticket, the way Linear draws one (docs/build-plan-issues.md D15).
 *
 * The measurements are Linear's own, taken off its issue view and written as
 * exact pixels for the same reason the project overview and the board are
 * (`routes/_app.projects.$projectId.tsx`): a 720px content column beside a 240px
 * properties rail that stacks under it at 900px of *container* width, a 26px
 * title on a 32px line, a 15px body on a 24px line, 13px properties on 28px rows.
 * Rounding those to the nearest utility class is what makes a copy look like an
 * imitation.
 *
 * The interaction is copied too, and that is the change this plan makes. The
 * project overview hands the reader to Linear for every edit, because Taut's
 * mirror decides nothing about a project (docs/build-plan-projects.md D1). A
 * ticket is the amendment (D1): every field here is editable, every edit is
 * written through to Linear and re-read from Linear's answer (D2), and every one
 * of them is optimistic so it feels like Linear's own pickers rather than like a
 * form (D3). `Open in Linear` stays in the header, where it belongs — for the
 * things Taut does not mirror, not for the things it will not do.
 *
 * The one thing that is *not* Linear's is Activity. Linear's history is read live
 * and rendered as events (D13), but the conversation underneath it is a real Taut
 * thread in a hidden per-project channel (D8, D9) — so it gets notifications,
 * unread counts, search, attachments, reactions and, the point, `@agent`. The
 * composer at the bottom is the app's own, and it posts through `openIssueThread`
 * until the thread exists and through the ordinary send path afterwards.
 */

/**
 * Linear's title field: always an editable box for anyone who may write, so the
 * ticket reads as something you change rather than something you are shown.
 *
 * Commits on blur and on ⌘↵, reverts on Escape — Linear's rules exactly. The
 * draft is seeded from the row and re-seeded whenever the row changes *while the
 * box is not focused*, which is what keeps a title edited in another browser (or
 * rewritten by Linear's answer, D2) from being clobbered without stealing the
 * words out from under somebody who is mid-sentence.
 *
 * A textarea rather than an input because a Linear title wraps; it is sized to
 * its content on every keystroke so it never scrolls inside itself.
 */
function TitleField({
  title,
  canEdit,
  onCommit
}: {
  title: string
  canEdit: boolean
  onCommit: (next: string) => void
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = React.useState(title)
  const focused = React.useRef(false)

  React.useEffect(() => {
    if (!focused.current) setDraft(title)
  }, [title])

  const autosize = React.useCallback(() => {
    const node = ref.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [])
  React.useEffect(autosize, [draft, autosize])

  if (!canEdit) {
    return <h1 className="text-[26px] leading-[32px] font-medium tracking-[-0.012em]">{title}</h1>
  }

  const commit = (): void => {
    const next = draft.trim()
    if (next === '' || next === title) {
      setDraft(title)
      return
    }
    onCommit(next)
  }

  return (
    <>
      <label htmlFor="issue-title" className="sr-only">
        Issue title
      </label>
      <textarea
        id="issue-title"
        ref={ref}
        rows={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={() => {
          focused.current = false
          commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(title)
            event.currentTarget.blur()
            return
          }
          // Plain ↵ would put a newline in a title, which Linear has no room for.
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        className="-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md bg-transparent px-2 py-0.5 text-[26px] leading-[32px] font-medium tracking-[-0.012em] outline-none transition-colors hover:bg-accent/30 focus:bg-accent/30"
      />
    </>
  )
}

/**
 * The ticket body: the app's markdown renderer until it is clicked, a textarea
 * after (D15). Same commit rules as the title.
 *
 * Rendered rather than always-editable because a description is mostly read —
 * checklists, links and code fences are the point of it, and a raw markdown
 * source sitting on the page all day is a worse default than a rendered one that
 * turns into a source when you aim at it.
 */
function DescriptionField({
  description,
  canEdit,
  onCommit
}: {
  description: string | undefined
  canEdit: boolean
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const ref = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    if (draft === null) return
    const node = ref.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.max(node.scrollHeight, 120)}px`
  }, [draft])

  if (draft !== null) {
    const commit = (): void => {
      const next = draft.trim()
      setDraft(null)
      if (next !== (description ?? '')) onCommit(next)
    }
    return (
      <>
        <label htmlFor="issue-description" className="sr-only">
          Description
        </label>
        <textarea
          id="issue-description"
          ref={ref}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(null)
              return
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              commit()
            }
          }}
          className="taut-scroll -mx-2 block w-[calc(100%+1rem)] resize-none rounded-md bg-accent/30 px-2 py-1 text-[15px] leading-[24px] outline-none focus:ring-[3px] focus:ring-ring/50"
        />
      </>
    )
  }

  const open = (): void => {
    if (canEdit) setDraft(description ?? '')
  }

  if (description === undefined || description.trim() === '') {
    return (
      <button
        type="button"
        onClick={open}
        disabled={!canEdit}
        className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1 text-left text-[15px] leading-[24px] text-muted-foreground transition-colors enabled:hover:bg-accent/30"
      >
        {canEdit ? 'Add a description…' : 'No description.'}
      </button>
    )
  }

  return (
    <div
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      onClick={(event) => {
        /*
         * A rendered description is full of things that are already clickable —
         * links, task-list checkboxes, code blocks somebody is selecting. Aiming
         * at one of those means the link, not the editor; anywhere else in the
         * body means the editor, which is Linear's own behaviour.
         */
        if (event.target instanceof Element && event.target.closest('a') !== null) return
        open()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
      className={cn(
        '-mx-2 rounded-md px-2 py-1',
        canEdit && 'cursor-text transition-colors hover:bg-accent/30'
      )}
    >
      <Markdown
        source={description}
        className="text-[15px] leading-[24px] [&_p]:my-3 [&_p]:first:mt-0 [&_p]:last:mb-0"
      />
    </div>
  )
}

/** One sub-issue, drawn as the 32px row Linear puts under a parent ticket (D16). */
function SubIssueRow({ issue }: { issue: ProjectIssue }) {
  return (
    <li>
      <Link
        to="/issues/$issueId"
        params={{ issueId: issue.id }}
        className="-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 transition-colors hover:bg-accent/40"
      >
        <ProjectPriorityIcon priority={issue.priority} />
        <span className="w-[86px] shrink-0 truncate text-[13px] text-muted-foreground tabular-nums">
          {issue.identifier}
        </span>
        <IssueStateIcon type={issue.state.type} color={issue.state.color} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{issue.title}</span>
        <IssueAvatar person={issue.assignee} px={20} />
      </Link>
    </li>
  )
}

function IssueRoute() {
  const { issueId } = Route.useParams()
  const navigate = useNavigate()

  const query = useIssue(issueId)
  const detail = query.data
  const issue = detail?.issue
  const project = detail?.project

  const activity = useIssueActivity(issueId)
  const options = useIssueOptions(project?.id)
  const update = useUpdateIssue(issueId)
  const remove = useDeleteIssue()
  const openThread = useOpenIssueThread(issueId)

  // D4: editing a ticket is ordinary work, so every member may. Deleting one is
  // not recoverable from Taut, so it keeps the gate the connection has.
  const canEdit = useMyRole() !== undefined
  const canDelete = useCanAdminister()

  const [confirming, setConfirming] = React.useState(false)
  const [addingSubIssue, setAddingSubIssue] = React.useState(false)

  /*
   * Where the ticket's conversation lives (D9). Two ways to find it, because
   * neither is always available: the project's hidden channel is in the channel
   * list once the reader has been joined to it (D21), and until then any reply
   * already loaded carries its own `channelId`. A reader who has never posted on
   * a ticket nobody has replied to gets neither — and posts through
   * `openIssueThread`, which is idempotent and needs no channel at all.
   */
  const { all: channels } = useChannelGroups()
  const threadId = issue?.threadId
  const thread = useThread(threadId)
  const replies = React.useMemo(() => flattenThread(thread.data), [thread.data])
  const channelId = React.useMemo(
    () =>
      channels.find((channel) => channel.projectId === project?.id)?.id ?? replies[0]?.channelId,
    [channels, project, replies]
  )
  const channelMessages = useMessages(channelId)
  /*
   * The root message is the first thing somebody said (D10), and it is a
   * *top-level* message in the hidden channel — `messages.thread` answers with
   * replies only. So it is read out of the channel cache, exactly the way
   * `thread-panel.tsx` reads the root of any other thread; and, exactly like that
   * panel, the feed copes with not finding it rather than blocking on it.
   */
  const root = React.useMemo(
    () =>
      threadId === undefined
        ? undefined
        : flattenChannel(channelMessages.data).find((message) => message.id === threadId),
    [channelMessages.data, threadId]
  )
  const messages = React.useMemo<readonly Message[]>(
    () => (root === undefined ? replies : [root, ...replies]),
    [root, replies]
  )

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Issue" icon={<SquareKanbanIcon className="size-4" />} />
        <div className="taut-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="taut-issue-layout mx-auto w-full max-w-[1064px] px-4 pt-6 sm:px-8 sm:pt-8">
            <div className="taut-issue-grid">
              <div>
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="mt-4 h-5 w-full" />
                <Skeleton className="mt-2 h-5 w-4/5" />
                <Skeleton className="mt-10 h-24 w-full rounded-lg" />
              </div>
              <div className="space-y-2">
                {[0, 1, 2, 3, 4].map((row) => (
                  <Skeleton key={row} className="h-7 w-full" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  if (detail === undefined || issue === undefined || project === undefined) {
    return (
      <>
        <PageHeader title="Issue" icon={<SquareKanbanIcon className="size-4" />} />
        <div className="taut-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <EmptyState
            icon={<SquareKanbanIcon className="size-5" />}
            title="This ticket is not in the mirror"
            description="It may have been trashed in Linear, moved to a project Taut does not sync, or the identifier is not one this workspace knows."
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

  const copyLink = (): void => {
    void navigator.clipboard
      .writeText(window.location.href)
      .then(() => toast.success(`Link to ${issue.identifier} copied`))
      .catch(() => toast.error('Could not reach the clipboard'))
  }

  return (
    <DocumentWorkspace channelId={channelId} threadId={threadId}>
      <PageHeader
        icon={<IssueStateIcon type={issue.state.type} color={issue.state.color} />}
        title={
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal">
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              search={{ tab: 'issues' }}
              className="truncate text-muted-foreground transition-colors hover:text-foreground"
            >
              {project.name}
            </Link>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium tabular-nums">{issue.identifier}</span>
          </span>
        }
        actions={
          <>
            {channelId === undefined || threadId === undefined ? null : (
              <ChannelCanvases
                key={`${channelId}:${threadId}`}
                channelId={channelId}
                threadId={threadId}
              />
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Copy link" onClick={copyLink}>
              <LinkIcon />
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={issue.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open in Linear
              </a>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More">
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={copyLink}>
                  <LinkIcon />
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={issue.url} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon />
                    Open in Linear
                  </a>
                </DropdownMenuItem>
                {canDelete ? (
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                    <Trash2Icon />
                    Delete issue
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="taut-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="taut-issue-layout mx-auto w-full max-w-[1064px] px-4 pt-6 sm:px-8 sm:pt-8 pb-6">
          <div className="taut-issue-grid">
            <div className="min-w-0">
              {issue.parent === undefined ? null : (
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: issue.parent.identifier }}
                  className="mb-2 -ml-2 flex h-7 w-fit max-w-full items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                >
                  <span className="shrink-0 tabular-nums">{issue.parent.identifier}</span>
                  <span className="truncate">{issue.parent.title}</span>
                </Link>
              )}

              <TitleField
                title={issue.title}
                canEdit={canEdit}
                onCommit={(title) =>
                  update.mutate({
                    patch: { title },
                    optimistic: (current) => new ProjectIssueValue({ ...current, title }, true)
                  })
                }
              />

              <div className="mt-3">
                <DescriptionField
                  description={issue.description}
                  canEdit={canEdit}
                  onCommit={(description) =>
                    update.mutate({
                      patch: { description: description === '' ? null : description },
                      optimistic: (current) =>
                        new ProjectIssueValue(
                          { ...current, description: description === '' ? undefined : description },
                          true
                        )
                    })
                  }
                />
              </div>

              <section className="mt-8">
                <h2 className="text-[12px] font-medium text-muted-foreground">
                  Sub-issues
                  {detail.subIssues.length === 0 ? null : (
                    <span className="ml-1.5 tabular-nums">{detail.subIssues.length}</span>
                  )}
                </h2>
                {detail.subIssues.length === 0 ? null : (
                  <ul className="mt-1.5">
                    {detail.subIssues.map((sub) => (
                      <SubIssueRow key={sub.id} issue={sub} />
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setAddingSubIssue(true)}
                  className="mt-1 -ml-2 flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors enabled:hover:bg-accent/40 enabled:hover:text-foreground disabled:opacity-50"
                >
                  <PlusIcon className="size-3.5" />
                  Add sub-issue
                </button>
              </section>
            </div>

            <IssuePropertyRail
              issue={issue}
              project={project}
              options={options.data}
              canEdit={canEdit}
              onEdit={(edit) => update.mutate(edit)}
            />
          </div>
        </div>

        <div className="mx-auto w-full max-w-[1064px] px-4 pb-6 sm:px-8">
          <div className="max-w-[720px]">
            <h2 className="mb-1 px-6 text-[12px] font-medium text-muted-foreground">Activity</h2>
            <IssueActivityFeed
              activity={activity.data}
              isPending={activity.isPending}
              messages={messages}
              hasOlder={thread.hasNextPage}
              isLoadingOlder={thread.isFetchingNextPage}
              onLoadOlder={() => void thread.fetchNextPage()}
            />
          </div>
        </div>
      </div>

      {/*
        The app's own composer, not a second one (D15). Two ways in and one box:
        with no thread yet — or with a thread whose hidden channel this browser
        has not been joined to (D21) — the send goes through `openIssueThread`,
        which creates the thread the first time and replies to it every time
        after. Once the channel is known it is an ordinary thread reply, which is
        what makes attachments, run overrides and `@agent` work here for free.
      */}
      <div className="mx-auto w-full max-w-[1064px] px-4 sm:px-8">
        <div className="max-w-[720px]">
          {threadId === undefined || channelId === undefined ? (
            <Composer
              channelId={undefined}
              placeholder={`Say something about ${issue.identifier}…`}
              onSend={(body) => openThread.mutate(body)}
            />
          ) : (
            <Composer
              channelId={channelId}
              threadId={threadId}
              placeholder={`Reply about ${issue.identifier}…`}
            />
          )}
        </div>
      </div>

      <IssueCreateDialog
        open={addingSubIssue}
        onOpenChange={setAddingSubIssue}
        projectId={project.id}
        parent={{
          linearId: issue.linearId,
          identifier: issue.identifier,
          title: issue.title
        }}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${issue.identifier}?`}
        description={
          <>
            <p>
              This trashes the ticket in Linear. Linear keeps it restorable for 30 days; Taut drops
              its row now.
            </p>
            <p>
              The conversation survives — dropping it with the row would destroy the only record of
              why the ticket was deleted.
            </p>
          </>
        }
        confirmLabel="Delete issue"
        confirmWord={issue.identifier}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(issueId, {
            onSuccess: () => {
              setConfirming(false)
              toast.success(`${issue.identifier} moved to Linear's trash`)
              void navigate({
                to: '/projects/$projectId',
                params: { projectId: project.id },
                search: { tab: 'issues' }
              })
            }
          })
        }
      />
    </DocumentWorkspace>
  )
}

export const Route = createFileRoute('/_app/issues/$issueId')({
  component: IssueRoute
})
