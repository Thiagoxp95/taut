import { InlineMessageComponent } from '@/components/message-component'
import { MemberProfileTrigger } from '@/components/profile-card'
import * as React from 'react'
import {
  AlarmClockIcon,
  AlertTriangleIcon,
  ChevronRightIcon,
  Loader2Icon,
  PauseIcon,
  RotateCcwIcon
} from '@taut/ui/components/icons'
import type { Avatar as AvatarValue, MemberKind, Message, ThreadSummary } from '@taut/contract'
import { TaskId } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { Button } from '@taut/ui/components/button'
import { AttachmentList } from '@/components/attachment-list'
import { ContextMeter } from '@/components/context-meter'
import { EntityAvatar } from '@/components/entity-avatar'
import { MessageAuthorization } from '@/components/message-authorization'
import { MessageActions } from '@/components/message-actions'
import { ReactionChips } from '@/components/reaction-chips'
import { RichText } from '@/components/rich-text'
import { useLookupMember } from '@/hooks/use-directory'
import type { AgentFace } from '@/lib/agent-avatar'
import { useCancelTask } from '@/lib/api'
import { formatRelative, formatTime, toIso } from '@/lib/format'
import {
  type Activity,
  type ThreadRun,
  useThreadRuns,
  useMessageActivity,
  useMessageTaskId,
  useMessageError,
  useThreadContext
} from '@/lib/live'
import { rememberRecentEmoji, useToggleReaction } from '@/lib/message-actions'

export interface MessageAuthor {
  readonly kind: MemberKind
  readonly name: string
  readonly handle: string
  readonly avatar: AvatarValue
  /** Agents only: their blobatar seed and department silhouette. */
  readonly face?: AgentFace
  readonly subtitle: string
  /** Agents only: archived, so the thread reads as answered by someone now retired. */
  readonly archived?: boolean
}

const UNKNOWN_AUTHOR: MessageAuthor = {
  kind: 'user',
  name: 'Unknown member',
  handle: 'unknown',
  avatar: { kind: 'emoji', value: '👤' },
  subtitle: ''
}

/** How many faces the reply bar shows before it stops counting. */
const FACES = 5

/** The reply entry stays visible while an agent prepares its first answer. */
function ThreadReplies({
  thread,
  threadId,
  onOpen
}: {
  thread?: ThreadSummary
  threadId: string
  onOpen: () => void
}) {
  const lookup = useLookupMember()
  const runs = useThreadRuns(threadId)
  if (thread === undefined && runs.length === 0) return null
  const participants: Array<{ kind: MemberKind; id: string }> = [...(thread?.participants ?? [])]
  for (const run of runs) {
    if (!participants.some((participant) => participant.id === run.agentId)) {
      participants.push({ kind: 'agent', id: run.agentId })
    }
  }
  const faces = participants.slice(0, FACES)
  // The server summary already counts streaming placeholders; never add them twice.
  const count = Math.max(thread?.replyCount ?? 0, runs.length)
  const label = `${count} ${count === 1 ? 'reply' : 'replies'}`

  return (
    <div className="mt-1.5 -ml-1 flex w-full min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label}${runs.length > 0 ? ' — reply in progress' : ''} — open thread`}
        className="group/thread flex w-fit max-w-full shrink-0 items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-left transition-colors hover:border-border hover:bg-background focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex shrink-0 -space-x-1">
          {faces.map((participant) => {
            const member = lookup(participant.id)
            return (
              <EntityAvatar
                memberId={participant.id}
                key={`${participant.kind}-${participant.id}`}
                avatar={member?.avatar ?? UNKNOWN_AUTHOR.avatar}
                kind={participant.kind}
                face={member?.face}
                working={runs.some((run) => run.agentId === participant.id)}
                name={member?.name ?? ''}
                size="sm"
                className="ring-2 ring-background"
              />
            )
          })}
        </span>

        <span className="shrink-0 text-[13px] font-semibold text-sidebar-primary group-hover/thread:underline dark:text-sidebar-primary-foreground">
          {label}
        </span>

        {runs.length === 0 && (
          <>
            <span className="truncate text-[11px] text-muted-foreground group-hover/thread:hidden">
              {thread === undefined ? null : `Last reply ${formatRelative(thread.lastReplyAt)}`}
            </span>
            <span className="hidden items-center gap-0.5 text-[11px] text-muted-foreground group-hover/thread:flex">
              View thread
              <ChevronRightIcon className="size-3" />
            </span>
          </>
        )}
      </button>
      {runs.length > 0 && (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          {runs.map((run) => (
            <ThreadReplyActivity key={run.messageId} run={run} />
          ))}
        </span>
      )}
    </div>
  )
}

function ThreadReplyActivity({ run }: { run: ThreadRun }) {
  const lookup = useLookupMember()
  const activity = useMessageActivity(run.messageId)
  const author = lookup(run.agentId) ?? { ...UNKNOWN_AUTHOR, name: 'Agent' }
  return <AgentActivityLine author={author} activity={activity} messageId={run.messageId} />
}

/**
 * One temporary line beside the working avatar. Each update replaces the previous one;
 * the completed reply replaces the entire row.
 */
function AgentActivityLine({
  author,
  activity,
  messageId
}: {
  author: MessageAuthor
  activity: Activity | undefined
  messageId: string
}) {
  const taskId = useMessageTaskId(messageId)
  const cancelTask = useCancelTask()
  const stopping = cancelTask.isPending || cancelTask.isSuccess
  const label = stopping ? `Stopping ${author.name}…` : `Interrupt ${author.name}`
  const text =
    activity === undefined ? `${author.name} is working…` : `${author.name} · ${activity.text}`
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-3">
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="taut-activity min-w-0 flex-1"
        >
          <span className="shimmer block truncate text-sm italic text-muted-foreground">
            {text}
          </span>
        </span>
        {taskId !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={label}
            title={label}
            disabled={stopping}
            onClick={() => cancelTask.mutate(TaskId.make(taskId))}
          >
            {stopping ? (
              <Loader2Icon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            ) : (
              <PauseIcon aria-hidden="true" className="size-4" />
            )}
          </Button>
        )}
      </span>
      {cancelTask.isError && (
        <span role="alert" className="text-xs text-destructive">
          Could not interrupt {author.name}. {cancelTask.error.message}
        </span>
      )}
    </span>
  )
}

export interface MessageBubbleProps {
  message: Message
  author?: MessageAuthor
  compact?: boolean
  /** The viewer wrote it: edit and delete are offered. */
  own?: boolean
  onEdit?: (body: string) => void
  onDelete?: () => void
  onOpenThread?: () => void
  onRetry?: () => void
  active?: boolean
  /**
   * The run this message set off came from a signal (docs/build-plan-triggers.md D21): the
   * body was posted as the author, but nobody typed it just now. Without the line the wake
   * reads as words the human wrote, which is the one thing it must never read as.
   */
  scheduled?: boolean
}

/**
 * A running agent occupies one activity row. Its completed answer gets the full message
 * treatment; progress never acquires a timestamp, actions, or a transcript of its own.
 */
export function MessageBubble({
  message,
  author = UNKNOWN_AUTHOR,
  compact = false,
  own = false,
  onEdit,
  onDelete,
  onOpenThread,
  onRetry,
  active = false,
  scheduled = false
}: MessageBubbleProps) {
  const streaming = message.status === 'streaming'
  /** Streaming, but nothing written yet: the orb holds the line until the first token. */
  const thinking = streaming && message.body.trim() === ''
  const failed = message.status === 'failed'
  const liveError = useMessageError(message.id)
  /**
   * The running commentary under this reply, while there is a run behind it
   * (docs/build-plan-activity.md D5). Broadcast, never stored: a reload mid-run shows the
   * orb and waits for the next line rather than replaying the ones it missed.
   */
  const activity = useMessageActivity(message.id)
  /**
   * How full this agent's window is *in this thread*
   * (docs/build-plan-context-meter.md D11). Only inside a thread: a message outside one belongs
   * to no session, and context is a property of the session, never of the agent.
   */
  const context = useThreadContext(
    message.authorKind === 'agent' ? message.authorId : undefined,
    message.threadId ?? undefined
  )
  const toggleReaction = useToggleReaction()
  const [draft, setDraft] = React.useState<string | null>(null)
  const editing = draft !== null
  // A file sent on its own has an empty body (D2) — no empty paragraph for it.
  const attachmentsOnly = message.body.trim() === '' && message.attachments.length > 0

  const react = (emoji: string, on: boolean): void => {
    toggleReaction.mutate({ messageId: message.id, emoji, on })
    if (on) rememberRecentEmoji(emoji)
  }

  const commit = (): void => {
    const next = draft?.trim() ?? ''
    if (next !== '' && next !== message.body) onEdit?.(next)
    setDraft(null)
  }

  if (streaming && message.authorKind === 'agent') {
    return (
      <article data-status="streaming" className="flex items-center gap-3 px-6 py-2">
        <div className="flex w-9 shrink-0 justify-center">
          <EntityAvatar
            memberId={message.authorId}
            avatar={author.avatar}
            kind={author.kind}
            face={author.face}
            working
            name={author.name}
            size="sm"
          />
        </div>
        <div className="min-w-0 flex-1">
          <AgentActivityLine author={author} activity={activity} messageId={message.id} />
        </div>
      </article>
    )
  }

  return (
    <article
      data-status={message.status}
      className={cn(
        'group relative flex gap-3 px-4 sm:px-6 transition-colors hover:bg-muted/40',
        active && 'bg-sidebar-primary/5',
        compact ? 'py-0.5' : 'pt-3 pb-1'
      )}
    >
      <div className="w-9 shrink-0">
        {compact ? (
          <time
            dateTime={toIso(message.createdAt)}
            className="mt-1 block text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          >
            {formatTime(message.createdAt)}
          </time>
        ) : (
          <ContextMeter context={context}>
            <EntityAvatar
              memberId={message.authorId}
              avatar={author.avatar}
              kind={author.kind}
              face={author.face}
              working={streaming}
              name={author.name}
              size="lg"
            />
          </ContextMeter>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {compact ? null : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <MemberProfileTrigger
              memberId={message.authorId}
              className="min-w-0 break-words text-[15px] font-semibold"
            >
              {author.name}
            </MemberProfileTrigger>
            {author.kind === 'agent' ? (
              <span className="rounded-[3px] bg-muted px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                agent
              </span>
            ) : null}
            {author.archived === true ? (
              <span className="rounded-[3px] border px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                archived
              </span>
            ) : null}
            <time dateTime={toIso(message.createdAt)} className="text-xs text-muted-foreground">
              {formatTime(message.createdAt)}
            </time>
            {message.editedAt !== undefined ? (
              <span className="text-xs text-muted-foreground">(edited)</span>
            ) : null}
          </div>
        )}

        {scheduled ? (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <AlarmClockIcon className="size-3" />
            scheduled by @{author.handle}
          </p>
        ) : null}

        {editing ? (
          <div className="mt-1 rounded-md border bg-background p-2 shadow-xs">
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(null)
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  commit()
                }
              }}
              className="taut-scroll block max-h-60 w-full resize-none bg-transparent text-[15px] leading-[1.46667] outline-none"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button variant="ghost" size="xs" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="xs" onClick={commit}>
                Save
              </Button>
            </div>
          </div>
        ) : thinking ? (
          <AgentActivityLine author={author} activity={activity} messageId={message.id} />
        ) : attachmentsOnly || message.component !== undefined ? null : (
          <RichText
            source={message.body}
            caret={streaming}
            className={cn(failed && 'text-muted-foreground')}
          />
        )}

        {message.component === undefined ? null : (
          <InlineMessageComponent messageId={message.id} component={message.component} />
        )}

        {message.authorization === undefined ? null : (
          <MessageAuthorization messageId={message.id} request={message.authorization} />
        )}

        {/* Under the body, and under the editor too: editing never touches them (D7). */}
        <AttachmentList
          attachments={message.attachments}
          threadId={message.threadId ?? message.id}
        />

        <ReactionChips message={message} onToggle={react} onAdd={(emoji) => react(emoji, true)} />

        {failed ? (
          <div className="mt-1.5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {liveError ?? 'The agent run failed before it could reply.'}
            </span>
            {onRetry === undefined ? null : (
              <Button
                variant="ghost"
                size="xs"
                className="-my-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onRetry}
              >
                <RotateCcwIcon />
                Retry
              </Button>
            )}
          </div>
        ) : null}

        {onOpenThread === undefined ? null : (
          <ThreadReplies thread={message.thread} threadId={message.id} onOpen={onOpenThread} />
        )}
        {editing ? null : (
          <MessageActions
            message={message}
            own={own}
            onEdit={onEdit === undefined ? undefined : () => setDraft(message.body)}
            onDelete={onDelete}
            onOpenThread={onOpenThread}
            onReact={react}
          />
        )}
      </div>
    </article>
  )
}
