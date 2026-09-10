import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CheckIcon, ForwardIcon, HashIcon, Loader2Icon } from '@taut/ui/components/icons'
import type { Channel, Message } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@taut/ui/components/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import { Textarea } from '@taut/ui/components/textarea'
import { toast } from '@taut/ui/components/sonner'
import { EntityAvatar } from '@/components/entity-avatar'
import {
  useChannel,
  useChannelGroups,
  useDmView,
  useDmViews,
  useLookupMember
} from '@/hooks/use-directory'
import { forwardBody, messageLink, useForwardMessage } from '@/lib/message-actions'

/**
 * D5: forwarding writes a quoting message into the target channel — there is no
 * forward endpoint. Attachments stay behind (`// TODO(plan)`); the footer links
 * back to the original.
 */
export function ForwardDialog({
  message,
  open,
  onOpenChange
}: {
  message: Message
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [target, setTarget] = React.useState<Channel | null>(null)
  const [comment, setComment] = React.useState('')
  const navigate = useNavigate()
  const { all } = useChannelGroups()
  const dms = useDmViews()
  const lookup = useLookupMember()
  const origin = useChannel(message.channelId)
  const originDm = useDmView(message.channelId)
  const forward = useForwardMessage()

  const channels = all
    .filter((channel) => channel.kind === 'channel')
    .sort((a, b) => a.name.localeCompare(b.name))
  const author = lookup(message.authorId)
  const source =
    origin === undefined
      ? 'a channel'
      : origin.kind === 'dm'
        ? `@${originDm?.label ?? origin.name}`
        : `#${origin.name}`

  const close = (next: boolean): void => {
    onOpenChange(next)
    if (!next) {
      setTarget(null)
      setComment('')
    }
  }

  const submit = (): void => {
    if (target === null || origin === undefined) return
    const body = forwardBody(comment, {
      message,
      handle: author?.handle ?? 'unknown',
      source,
      link: messageLink(origin, message)
    })
    forward.mutate(
      { channelId: target.id, body },
      {
        onSuccess: () => {
          close(false)
          toast('Message forwarded', {
            action: {
              label: 'View',
              onClick: () => {
                void (target.kind === 'dm'
                  ? navigate({ to: '/dm/$channelId', params: { channelId: target.id } })
                  : navigate({ to: '/c/$channelId', params: { channelId: target.id } }))
              }
            }
          })
        }
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>
            The original is quoted with a link back to where it was said.
          </DialogDescription>
        </DialogHeader>

        <Command className="rounded-md border">
          <CommandInput placeholder="Search channels and people…" />
          <CommandList className="max-h-48">
            <CommandEmpty>Nowhere to forward it to.</CommandEmpty>
            <CommandGroup heading="Channels">
              {channels.map((channel) => (
                <CommandItem
                  key={channel.id}
                  value={`#${channel.name}`}
                  onSelect={() => setTarget(channel)}
                >
                  <HashIcon />
                  <span className="truncate">{channel.name}</span>
                  {target?.id === channel.id ? <CheckIcon className="ml-auto size-4" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Direct messages">
              {dms.map((view) => (
                <CommandItem
                  key={view.channel.id}
                  value={`dm ${view.label} ${view.partner?.name ?? ''}`}
                  onSelect={() => setTarget(view.channel)}
                >
                  <EntityAvatar
                    onProfileNavigate={() => onOpenChange(false)}
                    memberId={view.partner?.id}
                    avatar={view.partner?.avatar ?? { kind: 'emoji', value: '💬' }}
                    kind={view.partner?.kind ?? 'user'}
                    face={view.partner?.face}
                    name={view.partner?.name ?? view.label}
                    size="sm"
                  />
                  <span className="truncate">{view.partner?.name ?? view.label}</span>
                  {target?.id === view.channel.id ? <CheckIcon className="ml-auto size-4" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>

        <Textarea
          rows={2}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Add a comment (optional)"
          className="min-h-0"
        />

        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <p className="font-medium">
            {author?.name ?? 'Unknown member'} in {source}
          </p>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-muted-foreground">
            {message.body.trim() === '' ? 'No text' : message.body}
          </p>
          {message.attachments.length === 0 ? null : (
            <p className="mt-1 text-muted-foreground">Attachments are not forwarded.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button disabled={target === null || forward.isPending} onClick={submit}>
            {forward.isPending ? <Loader2Icon className="animate-spin" /> : <ForwardIcon />}
            Forward
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
