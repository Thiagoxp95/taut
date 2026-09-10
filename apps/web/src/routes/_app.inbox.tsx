import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckIcon, MailIcon, PencilIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { cn } from '@taut/ui/lib/utils'
import type { DmInboxItem } from '@taut/contract/api'
import { AvatarVisual } from '@/components/avatar-visual'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { useCommandPalette } from '@/components/command-palette'
import { useDirectoryIndex, type Mentionable } from '@/hooks/use-directory'
import { useDmInbox, useMarkRead } from '@/lib/api'
import { formatDay, formatTime, toIso } from '@/lib/format'

function InboxRow({ item, partner }: { item: DmInboxItem; partner: Mentionable | undefined }) {
  const read = useMarkRead()
  const name = partner?.name ?? 'Unknown member'
  const pending = item.unread > 0

  return (
    <li className="group flex min-w-0 items-center border-b last:border-b-0">
      <Link
        to="/dm/$channelId"
        params={{ channelId: item.channelId }}
        search={{ thread: item.threadId ?? undefined, at: item.messageId }}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-4 py-4 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AvatarVisual
          avatar={partner?.avatar ?? { kind: 'emoji', value: '💬' }}
          kind={item.authorKind}
          face={partner?.face}
          name={name}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                'truncate text-sm',
                pending ? 'font-semibold' : 'font-medium text-muted-foreground'
              )}
            >
              {name}
            </span>
            {item.authorKind === 'agent' ? (
              <span className="text-xs text-muted-foreground">Agent</span>
            ) : null}
            {item.archivedAt !== null ? (
              <span className="text-xs text-muted-foreground">Archived</span>
            ) : null}
            {pending ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
                {item.unread} unread
              </span>
            ) : null}
            <time
              dateTime={toIso(item.createdAt)}
              className="ml-auto text-xs tabular-nums text-muted-foreground"
            >
              {formatDay(item.createdAt)} · {formatTime(item.createdAt)}
            </time>
          </div>
          <p
            className={cn(
              'mt-1 line-clamp-2 break-words text-sm text-pretty',
              !pending && 'text-muted-foreground'
            )}
          >
            {item.body || 'Shared an attachment'}
          </p>
          {item.threadId !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">Reply in a thread</p>
          ) : null}
        </div>
      </Link>
      {pending ? (
        <div className="shrink-0 pr-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Mark messages from ${name} as read`}
            title="Mark as read"
            disabled={read.isPending}
            onClick={() => read.mutate({ channelId: item.channelId, lastReadSeq: item.seq })}
          >
            <CheckIcon className="size-4" />
          </Button>
          {read.error ? (
            <p role="alert" className="max-w-32 text-xs text-destructive">
              {read.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function InboxRoute() {
  const inbox = useDmInbox()
  const directory = useDirectoryIndex()
  const palette = useCommandPalette()
  const [unreadOnly, setUnreadOnly] = React.useState(false)
  const all = inbox.data?.items ?? []
  const pending = all.filter((item) => item.unread > 0)
  const items = unreadOnly ? pending : all

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Direct messages from your agents and teammates."
        icon={<MailIcon className="size-5" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => palette.open('dm')}>
            <PencilIcon className="size-4" />
            New message
          </Button>
        }
      />
      <PageBody>
        <div className="mx-auto max-w-4xl">
          <div className="mb-4 flex items-center gap-2" role="group" aria-label="Filter inbox">
            <Button
              variant={unreadOnly ? 'ghost' : 'secondary'}
              size="sm"
              aria-pressed={!unreadOnly}
              onClick={() => setUnreadOnly(false)}
            >
              All messages
            </Button>
            <Button
              variant={unreadOnly ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly(true)}
            >
              Unread{pending.length > 0 ? ` (${pending.length})` : ''}
            </Button>
          </div>
          {inbox.isPending ? (
            <div role="status" aria-label="Loading inbox" className="space-y-3">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-20 w-full rounded-lg" />
              ))}
            </div>
          ) : inbox.isError ? (
            <div role="alert" className="space-y-3 text-sm">
              <p className="text-destructive">{inbox.error.message}</p>
              <Button variant="outline" onClick={() => void inbox.refetch()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<MailIcon className="size-5" />}
              title={unreadOnly ? 'You’re all caught up' : 'Your inbox is quiet'}
              description={
                unreadOnly
                  ? 'No unread direct messages.'
                  : 'When an agent or teammate messages you, it appears here. Agents can DM their department head directly.'
              }
              action={
                <Button
                  variant="outline"
                  onClick={() => (unreadOnly ? setUnreadOnly(false) : palette.open('dm'))}
                >
                  {unreadOnly ? 'View all messages' : 'New message'}
                </Button>
              }
            />
          ) : (
            <ul aria-label="Received conversations" className="rounded-xl border">
              {items.map((item) => (
                <InboxRow key={item.channelId} item={item} partner={directory.get(item.authorId)} />
              ))}
            </ul>
          )}
        </div>
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/inbox')({ component: InboxRoute })
