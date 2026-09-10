import * as React from 'react'
import {
  ArchiveIcon,
  CalendarIcon,
  CirclePlusIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GaugeIcon,
  GitBranchIcon,
  Loader2Icon,
  PencilIcon,
  SquareKanbanIcon,
  TagIcon,
  UserIcon
} from '@taut/ui/components/icons'
import type {
  IssueActivity,
  IssueHistoryEvent,
  IssueHistoryKind,
  IssueLinearComment,
  Message
} from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { IssueAvatar } from '@/components/issue-avatar'
import { MessageBubble } from '@/components/message-bubble'
import { RichText } from '@/components/rich-text'
import { useMessageAuthor } from '@/hooks/use-directory'
import { useDeleteMessage, useEditMessage, useMe } from '@/lib/api'
import { formatRelative, toMillis } from '@/lib/format'

/**
 * A ticket's Activity: Linear's own history, the Linear comments Taut refuses to
 * author, and the ticket's Taut thread — one list, in time order
 * (docs/build-plan-issues.md D11, D13).
 *
 * Three kinds of row, drawn as three different things because they *are* three
 * different things:
 *
 * 1. A **history event** is one line. Linear's own: a 16px actor avatar on a 1px
 *    rail, the sentence the server composed out of the from/to pair, and the age
 *    on the right. Consecutive events share a rail, and anything that is not an
 *    event breaks it — which is exactly how Linear's feed reads, and why the rail
 *    is drawn per run rather than down the whole column.
 * 2. A **Linear comment** is a read-only card with a link back to Linear. It is
 *    not a message and must never look like one: mirroring a stranger's comment
 *    as a Taut message means picking a Taut author for it, and every available
 *    choice is a lie about who said it (D11).
 * 3. A **thread message** is drawn by `MessageBubble` — the app's own message
 *    row, the same one the channel and the thread panel use. Not `MessageList`:
 *    that is a scroll viewport with its own reverse-infinite-scroll and
 *    bottom-pinning, and it cannot interleave rows it does not own. The renderer
 *    is what gets reused here, which is the part that must not be written twice.
 *
 * The order is the wall clock, ascending — oldest first, like every other message
 * list in the app. Linear's history is almost always older than the thread (a
 * thread does not exist until somebody says the first thing, D8), but not always:
 * moving a ticket to Done after the conversation is the ordinary case, and a feed
 * that pinned history above messages would put that event before words that
 * predate it.
 */

/** Which glyph an event gets. `other` is a change Taut has never heard of (D13). */
const HISTORY_ICON: Record<IssueHistoryKind, React.ComponentType<{ className?: string }>> = {
  created: CirclePlusIcon,
  state: SquareKanbanIcon,
  assignee: UserIcon,
  priority: GaugeIcon,
  label: TagIcon,
  title: PencilIcon,
  description: FileTextIcon,
  milestone: CalendarIcon,
  dueDate: CalendarIcon,
  parent: GitBranchIcon,
  project: SquareKanbanIcon,
  estimate: GaugeIcon,
  archived: ArchiveIcon,
  other: PencilIcon
}

type Row =
  | { readonly kind: 'history'; readonly at: number; readonly event: IssueHistoryEvent }
  | { readonly kind: 'comment'; readonly at: number; readonly comment: IssueLinearComment }
  | { readonly kind: 'message'; readonly at: number; readonly message: Message }

/** Consecutive history events, so one rail can be drawn down the run. */
type Block =
  | {
      readonly kind: 'history'
      readonly key: string
      readonly events: readonly IssueHistoryEvent[]
    }
  | { readonly kind: 'comment'; readonly key: string; readonly comment: IssueLinearComment }
  | { readonly kind: 'message'; readonly key: string; readonly message: Message }

const blocksOf = (rows: readonly Row[]): readonly Block[] => {
  const out: Array<
    | { kind: 'history'; key: string; events: IssueHistoryEvent[] }
    | { kind: 'comment'; key: string; comment: IssueLinearComment }
    | { kind: 'message'; key: string; message: Message }
  > = []
  for (const row of rows) {
    if (row.kind === 'comment') {
      out.push({ kind: 'comment', key: `c-${row.comment.linearId}`, comment: row.comment })
      continue
    }
    if (row.kind === 'message') {
      out.push({ kind: 'message', key: `m-${row.message.id}`, message: row.message })
      continue
    }
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === 'history') last.events.push(row.event)
    else out.push({ kind: 'history', key: `h-${row.event.linearId}`, events: [row.event] })
  }
  return out
}

/** One line of Linear's history, on the rail its run shares. */
function HistoryRow({ event }: { event: IssueHistoryEvent }) {
  const Icon = HISTORY_ICON[event.kind]
  return (
    <li className="relative flex min-h-[28px] items-center gap-2 py-[3px] pl-[34px]">
      {/*
        The rail marker: 16px, centred on the line 12px into the gutter, with a
        4px ring of the page's own background so it breaks the rail rather than
        sitting on top of it. Linear draws the actor here and no glyph beside the
        sentence — the face is the subject, the sentence is the predicate.
      */}
      <span className="absolute top-1/2 left-[4px] -translate-y-1/2">
        {event.actor === undefined ? (
          // No actor is Linear saying an automation did it — a glyph, not a
          // silhouette, because "unassigned" and "nobody in particular" are two
          // different absences and the rail must not conflate them.
          <span className="flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground ring-4 ring-background">
            <Icon className="size-2.5" />
          </span>
        ) : (
          <IssueAvatar person={event.actor} px={16} className="ring-4 ring-background" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        {event.actor === undefined ? null : (
          <span className="text-foreground">{event.actor.name} </span>
        )}
        {event.summary}
      </span>
      <span className="shrink-0 text-[12px] whitespace-nowrap text-muted-foreground">
        {formatRelative(event.at)}
      </span>
    </li>
  )
}

/**
 * A comment that lives in Linear, by somebody Taut has no name for (D11).
 * Read-only, visibly foreign, and linked back to where it can be answered.
 */
function LinearCommentCard({ comment }: { comment: IssueLinearComment }) {
  return (
    <article className="rounded-lg border border-dashed px-3 py-2.5">
      <header className="flex items-center gap-2">
        <IssueAvatar person={comment.author} px={20} />
        <span className="min-w-0 truncate text-[13px] font-medium">
          {comment.author?.name ?? 'Someone in Linear'}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {formatRelative(comment.createdAt)}
        </span>
        <a
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          title="This comment in Linear — where it can be answered"
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </header>
      <RichText source={comment.body} className="mt-1.5 text-[14px] leading-[22px]" />
    </article>
  )
}

export function IssueActivityFeed({
  activity,
  isPending,
  messages,
  hasOlder,
  isLoadingOlder,
  onLoadOlder
}: {
  /** `undefined` while Linear is being read, or after it refused (D13). */
  activity: IssueActivity | undefined
  isPending: boolean
  /** The ticket's thread, oldest first — empty until somebody opens one (D8). */
  messages: readonly Message[]
  hasOlder: boolean
  isLoadingOlder: boolean
  onLoadOlder: () => void
}) {
  const me = useMe().data
  const authorOf = useMessageAuthor()
  const editMessage = useEditMessage()
  const deleteMessage = useDeleteMessage()

  const blocks = React.useMemo(() => {
    const rows: Row[] = []
    for (const event of activity?.history ?? []) {
      rows.push({ kind: 'history', at: toMillis(event.at), event })
    }
    for (const comment of activity?.comments ?? []) {
      rows.push({ kind: 'comment', at: toMillis(comment.createdAt), comment })
    }
    for (const message of messages) {
      rows.push({ kind: 'message', at: toMillis(message.createdAt), message })
    }
    rows.sort((a, b) => a.at - b.at)
    return blocksOf(rows)
  }, [activity, messages])

  if (isPending && messages.length === 0) {
    return (
      <div className="space-y-2 px-6 py-2">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-3/5" />
      </div>
    )
  }

  if (blocks.length === 0) {
    return (
      <p className="px-6 py-4 text-[13px] text-muted-foreground">
        Nothing yet. Say something below and this ticket gets a thread of its own — mentions,
        notifications and <span className="font-medium">@agent</span> included.
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {hasOlder ? (
        <div className="flex justify-center py-2">
          <Button variant="outline" size="sm" disabled={isLoadingOlder} onClick={onLoadOlder}>
            {isLoadingOlder ? <Loader2Icon className="animate-spin" /> : null}
            Load older messages
          </Button>
        </div>
      ) : null}

      {blocks.map((block) => {
        if (block.kind === 'history') {
          return (
            <ol key={block.key} className="relative px-6 py-1">
              {/*
                The rail: one 1px line down the run, ending half a row short at
                each end so it reads as connecting these events rather than
                pointing at whatever is above and below them.
              */}
              <span aria-hidden className="absolute top-3 bottom-3 left-[36px] w-px bg-border" />
              {block.events.map((event) => (
                <HistoryRow key={event.linearId} event={event} />
              ))}
            </ol>
          )
        }

        if (block.kind === 'comment') {
          return (
            <div key={block.key} className="px-6 py-1">
              <LinearCommentCard comment={block.comment} />
            </div>
          )
        }

        const message = block.message
        const own = message.authorKind === 'user' && message.authorId === me?.user.id
        return (
          <MessageBubble
            key={block.key}
            message={message}
            author={authorOf(message)}
            own={own}
            onEdit={own ? (body) => editMessage.mutate({ messageId: message.id, body }) : undefined}
            onDelete={own ? () => deleteMessage.mutate(message.id) : undefined}
          />
        )
      })}
    </div>
  )
}
