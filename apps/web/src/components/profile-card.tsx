import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { BotIcon, MailIcon, MessageSquareIcon } from 'lucide-react'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import { cn } from '@taut/ui/lib/utils'
import { EntityAvatar } from '@/components/entity-avatar'
import { PresenceDot, presenceLabel } from '@/components/presence-dot'
import { useLookupHandle, type Mentionable } from '@/hooks/use-directory'
import { useMe, useOpenDm } from '@/lib/api'
import { usePresence } from '@/lib/live'
import { RUNTIME_LABELS } from '@/lib/runtime-meta'

/**
 * The profile card behind every `@handle` chip — Slack's hover card, opened on
 * click. Humans get name, role and email; agents get their job line, runtime
 * and a way through to the full agent page. Both get a "Message" button that
 * opens (or reuses) the DM.
 */
export function MemberProfileCard({
  member,
  onDone
}: {
  member: Mentionable
  /** Called once navigation is under way, so a popover can close itself. */
  onDone?: () => void
}) {
  const navigate = useNavigate()
  const me = useMe().data
  const openDm = useOpenDm()
  const presence = usePresence(member.id, member.defaultPresence)
  const agent = member.kind === 'agent' ? member.agent : undefined
  const isSelf = member.kind === 'user' && member.id === me?.user.id

  const message = (): void => {
    openDm.mutate(
      { memberKind: member.kind, memberId: member.id },
      {
        onSuccess: (channel) => {
          onDone?.()
          void navigate({ to: '/dm/$channelId', params: { channelId: channel.id } })
        }
      }
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <EntityAvatar
          avatar={member.avatar}
          kind={member.kind}
          face={member.face}
          name={member.name}
          presence={presence}
          size="xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold">{member.name}</p>
            {agent === undefined ? null : (
              <span className="rounded-[3px] bg-muted px-1 py-px text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                agent
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">@{member.handle}</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <PresenceDot presence={presence} />
            {presenceLabel(presence)}
          </p>
        </div>
      </div>

      <dl className="space-y-1 text-xs">
        {member.kind === 'user' ? (
          <>
            <div className="flex items-center gap-2">
              <dt className="sr-only">Role</dt>
              <dd>
                <Badge variant="outline">{member.role}</Badge>
              </dd>
            </div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <dt className="sr-only">Email</dt>
              <MailIcon className="size-3.5 shrink-0" />
              <dd className="min-w-0 truncate">
                <a href={`mailto:${member.email}`} className="hover:underline">
                  {member.email}
                </a>
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <dt className="sr-only">Role</dt>
              <BotIcon className="size-3.5 shrink-0" />
              <dd className="min-w-0 truncate">{agent?.role || 'Agent'}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="sr-only">Runtime</dt>
              <dd className="flex items-center gap-1.5">
                <Badge variant="outline">
                  {agent === undefined ? '' : RUNTIME_LABELS[agent.runtimeKind]}
                </Badge>
                {agent?.status === 'paused' ? <Badge variant="secondary">paused</Badge> : null}
              </dd>
            </div>
          </>
        )}
      </dl>

      <div className="flex items-center gap-2">
        {isSelf ? null : (
          <Button size="sm" disabled={openDm.isPending} onClick={message}>
            <MessageSquareIcon />
            Message
          </Button>
        )}
        {agent === undefined ? null : (
          <Button asChild size="sm" variant="outline">
            <Link to="/agents/$agentId" params={{ agentId: agent.id }} onClick={() => onDone?.()}>
              View profile
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Wraps a mention chip (or any trigger) so clicking it opens the profile card.
 * An unknown handle — someone who left, or a typo — renders the trigger as-is:
 * there is nothing to show.
 */
export function ProfilePopover({
  handle,
  className,
  children
}: {
  handle: string
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const member = useLookupHandle()(handle)

  if (member === undefined) return <>{children}</>

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Open the profile of ${member.name}`}
          className={cn('cursor-pointer', className)}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <MemberProfileCard member={member} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
