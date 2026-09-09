import * as React from 'react'
import { AlarmClockIcon, AlertTriangleIcon, ChevronRightIcon, RotateCcwIcon } from 'lucide-react'
import type { Avatar as AvatarValue, MemberKind, Message, ThreadSummary } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { Button } from '@taut/ui/components/button'
import { AgentFigure } from '@/components/agent-figure'
import { AttachmentList } from '@/components/attachment-list'
import { ContextMeter } from '@/components/context-meter'
import { EntityAvatar } from '@/components/entity-avatar'
import { MessageActions } from '@/components/message-actions'
import { ReactionChips } from '@/components/reaction-chips'
import { RichText } from '@/components/rich-text'
import { useLookupMember } from '@/hooks/use-directory'
import type { AgentFace } from '@/lib/agent-avatar'
import { formatRelative, formatTime, toIso } from '@/lib/format'
import { useIsInvoking, useMessageError, useThreadContext } from '@/lib/live'
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

/** The placeholder orb's size. At or under 24 the library paints its sparse inline preset. */
const ORB_PX = 20

/**
 * Slack's reply bar: the avatars of everyone who answered, the count, and how
 * long ago the last reply landed. Only a root message with replies gets one.
 *
 * `working` is the run this message set off still being in flight — the same
 * signal that shimmers the body. The agent faces here morph into their orb for
 * exactly that long, which is the one place an unopened thread says an answer
 * is on its way.
 */
function ThreadReplies({
  thread,
  working,
  onOpen
}: {
  thread: ThreadSummary
  working: boolean
  onOpen: () => void
}) {
  const lookup = useLookupMember()
  const faces = thread.participants.slice(0, FACES)
  const label = `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label} — open thread`}
      className="group/thread mt-1.5 -ml-1 flex w-fit max-w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-left transition-colors hover:border-border hover:bg-background"
    >
      <span className="flex -space-x-1">
        {faces.map((participant) => {
          const member = lookup(participant.id)
          return (
            <EntityAvatar
              key={`${participant.kind}-${participant.id}`}
              avatar={member?.avatar ?? UNKNOWN_AUTHOR.avatar}
              kind={participant.kind}
              face={member?.face}
              working={working}
              name={member?.name ?? ''}
              size="sm"
              className="ring-2 ring-background"
            />
          )
        })}
      </span>

      <span className="text-[13px] font-semibold text-sidebar-primary group-hover/thread:underline dark:text-sidebar-primary-foreground">
        {label}
      </span>

      <span className="truncate text-[11px] text-muted-foreground group-hover/thread:hidden">
        Last reply {formatRelative(thread.lastReplyAt)}
      </span>
      <span className="hidden items-center gap-0.5 text-[11px] text-muted-foreground group-hover/thread:flex">
        View thread
        <ChevronRightIcon className="size-3" />
      </span>
    </button>
  )
}

/**
 * What stands in for the reply until its first token lands: the agent's orb at
 * the inline preset — the loose, floaty dots of a small avatar rather than the
 * dense sphere the 40px preset paints — sitting on the line the text will take.
 * The caret alone left the row looking empty, which read as a stalled reply.
 */
function ThinkingPlaceholder({ author }: { author: MessageAuthor }) {
  return (
    <div
      role="status"
      aria-label={`${author.name} is thinking`}
      className="flex min-h-[1lh] items-center"
    >
      <AgentFigure
        seed={author.face?.seed ?? author.name}
        shape={author.face?.shape}
        working
        px={ORB_PX}
      />
    </div>
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
 * One message row. Agent replies grow in place: `status: "streaming"` keeps a
 * caret pulsing at the end of the text and the avatar morphed into its orb. That
 * and the reply bar below are the only places the orb is drawn: everywhere else
 * a busy agent is a still face.
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
   * This message invoked an agent and that run is still going, so it shimmers until the agent is
   * done (docs/build-plan-shimmer.md D2). The dim is not decoration: `tw-shimmer` cannot show its
   * highlight on full-contrast text, so the sweep is invisible without it (D4).
   */
  const invoking = useIsInvoking(message.id)
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

  return (
    <article
      data-status={message.status}
      className={cn(
        'group relative flex gap-3 px-6 transition-colors hover:bg-muted/40',
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
              avatar={author.avatar}
              kind={author.kind}
              face={author.face}
              working={streaming}
              orb="composing"
              name={author.name}
              size="lg"
            />
          </ContextMeter>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {compact ? null : (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{author.name}</span>
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
            <time dateTime={toIso(message.createdAt)} className="text-[11px] text-muted-foreground">
              {formatTime(message.createdAt)}
            </time>
            {message.editedAt !== undefined ? (
              <span className="text-[11px] text-muted-foreground">(edited)</span>
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
              className="taut-scroll block max-h-60 w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
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
          <ThinkingPlaceholder author={author} />
        ) : attachmentsOnly ? null : (
          <RichText
            source={message.body}
            caret={streaming}
            className={cn(
              failed && 'text-muted-foreground',
              invoking && 'shimmer text-foreground/60'
            )}
          />
        )}

        {/* Under the body, and under the editor too: editing never touches them (D7). */}
        <AttachmentList attachments={message.attachments} />

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

        {message.thread === undefined || onOpenThread === undefined ? null : (
          <ThreadReplies thread={message.thread} working={invoking} onOpen={onOpenThread} />
        )}
      </div>

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
    </article>
  )
}
