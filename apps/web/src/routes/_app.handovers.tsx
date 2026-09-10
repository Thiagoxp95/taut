import * as React from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeftRightIcon, SendIcon, XIcon } from '@taut/ui/components/icons'
import type { Handover, HandoverStatus } from '@taut/contract'

import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { Textarea } from '@taut/ui/components/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { EntityAvatar } from '@/components/entity-avatar'
import { useDepartmentList, useDirectoryIndex } from '@/hooks/use-directory'
import { useDismissHandover, useHandovers, useRaiseHandover } from '@/lib/api'
import { formatRelative } from '@/lib/format'

const STATUSES: readonly HandoverStatus[] = ['open', 'raised', 'dismissed']

function isHandoverStatus(value: string): value is HandoverStatus {
  return STATUSES.some((status) => status === value)
}

/**
 * The form behind "Raise with …". It is keyed by handover id and mounted only while the
 * dialog is open, so a draft never survives into the next one. The textarea starts empty on
 * purpose: an empty note sends the server's default (the agent's own words, quoted), which is
 * what a head wants nine times out of ten, and anything typed replaces it wholesale.
 */
function RaiseForm({
  handover,
  headName,
  onClose
}: {
  handover: Handover
  headName: string
  onClose: () => void
}) {
  const [text, setText] = React.useState('')
  const raise = useRaiseHandover()

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (raise.isPending) return
        raise.mutate(
          { handoverId: handover.id, text: text.trim() === '' ? undefined : text.trim() },
          { onSuccess: onClose }
        )
      }}
    >
      <DialogHeader>
        <DialogTitle>Raise with {headName}</DialogTitle>
        <DialogDescription>
          Sends a DM from you to {headName}. Your agent stays blocked either way — only their
          department can pick this up.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={5}
        className="my-4"
        placeholder="Leave empty to send the default note (what your agent tried to say, quoted)."
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={raise.isPending}>
          <SendIcon />
          Send
        </Button>
      </DialogFooter>
    </form>
  )
}

function HandoverCard({
  handover,
  onRaise
}: {
  handover: Handover
  onRaise: (handover: Handover) => void
}) {
  const navigate = useNavigate()
  const directory = useDirectoryIndex()
  const { departments } = useDepartmentList()
  const dismiss = useDismissHandover()

  const from = directory.get(handover.fromAgentId)
  const to = directory.get(handover.toAgentId)
  const toDepartment = departments.find((entry) => entry.id === handover.toDepartmentId)
  const otherHead =
    handover.toHeadUserId === undefined ? undefined : directory.get(handover.toHeadUserId)

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <EntityAvatar
          memberId={from?.id}
          avatar={from?.avatar ?? { kind: 'emoji', value: '🤖' }}
          kind="agent"
          face={from?.face}
          name={from?.name ?? ''}
          size="sm"
        />
        <span className="font-medium">@{from?.handle ?? handover.fromAgentId}</span>
        <ArrowLeftRightIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">@{to?.handle ?? handover.toAgentId}</span>
        <span className="text-xs text-muted-foreground">
          in {toDepartment?.name ?? 'another department'}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(handover.createdAt)}
        </span>
      </div>

      <p className="mt-3 border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {handover.text}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {handover.status === 'open' ? (
          <>
            <Button
              size="sm"
              disabled={otherHead === undefined}
              title={
                otherHead === undefined
                  ? 'That department has no head yet — set one in its settings'
                  : undefined
              }
              onClick={() => onRaise(handover)}
            >
              <SendIcon />
              Raise with {otherHead === undefined ? 'their head' : `@${otherHead.handle}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(handover.id)}
            >
              <XIcon />
              Dismiss
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {handover.status === 'raised' ? 'Raised' : 'Dismissed'}
            {handover.resolvedAt === undefined ? '' : ` ${formatRelative(handover.resolvedAt)}`}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() =>
            void navigate({
              to: '/c/$channelId',
              params: { channelId: handover.channelId },
              search: handover.threadId === undefined ? {} : { thread: handover.threadId }
            })
          }
        >
          Open the thread
        </Button>
      </div>
    </li>
  )
}

function HandoversRoute() {
  const [status, setStatus] = React.useState<HandoverStatus>('open')
  const query = useHandovers(status)
  const handovers = query.data ?? []
  const [raising, setRaising] = React.useState<Handover | undefined>(undefined)

  const directory = useDirectoryIndex()
  const otherHead =
    raising?.toHeadUserId === undefined ? undefined : directory.get(raising.toHeadUserId)

  return (
    <>
      <PageHeader
        title="Handovers"
        description="Work your agents could not do because it belongs to another department. Only you can carry it across."
        icon={<ArrowLeftRightIcon className="size-4" />}
        actions={
          <Select
            value={status}
            onValueChange={(next) => setStatus(isHandoverStatus(next) ? next : 'open')}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <PageBody>
        {query.isPending ? (
          <Skeleton className="h-48 rounded-lg" />
        ) : handovers.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRightIcon className="size-5" />}
            title={status === 'open' ? 'Nothing waiting on you' : `No ${status} handovers`}
            description="Agents can only talk inside their own department. When one tries to reach another department, the attempt lands here for you to raise with that department's head — or drop."
          />
        ) : (
          <ul className="flex max-w-3xl flex-col gap-3">
            {handovers.map((handover) => (
              <HandoverCard key={handover.id} handover={handover} onRaise={setRaising} />
            ))}
          </ul>
        )}
      </PageBody>
      <Dialog
        open={raising !== undefined}
        onOpenChange={(open) => (open ? undefined : setRaising(undefined))}
      >
        <DialogContent>
          {raising === undefined ? null : (
            <RaiseForm
              key={raising.id}
              handover={raising}
              headName={otherHead === undefined ? 'their head' : `@${otherHead.handle}`}
              onClose={() => setRaising(undefined)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export const Route = createFileRoute('/_app/handovers')({
  component: HandoversRoute
})
