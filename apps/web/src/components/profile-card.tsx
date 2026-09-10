import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQueries } from '@tanstack/react-query'
import type { ChannelId } from '@taut/contract'
import {
  HeadphonesIcon,
  MailIcon,
  MessageSquareIcon,
  SettingsIcon
} from '@taut/ui/components/icons'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Popover, PopoverAnchor, PopoverContent } from '@taut/ui/components/popover'
import { cn } from '@taut/ui/lib/utils'
import { AvatarContext, AvatarVisual } from '@/components/avatar-visual'
import { HuddlePrejoin } from '@/components/huddle-prejoin'
import { PresenceDot, presenceLabel } from '@/components/presence-dot'
import { useDirectoryIndex, useLookupHandle, type Mentionable } from '@/hooks/use-directory'
import { useHuddle } from '@/hooks/use-huddle'
import { useAgent, useDepartments, useMe, useOpenDm } from '@/lib/api'
import { call } from '@/lib/api-client'
import { usePresence } from '@/lib/live'
import { qk } from '@/lib/query-keys'
import { runEffect } from '@/lib/runtime'

/** Fetch existing department memberships only while a human's card is visible. */
function MemberDepartments({ member }: { member: Mentionable }) {
  const departments = useDepartments().data?.items ?? []
  const details = useQueries({
    queries:
      member.kind === 'agent'
        ? []
        : departments.map((department) => ({
            queryKey: qk.department(department.id),
            queryFn: () =>
              runEffect(
                call((api) => api.departments.get({ path: { departmentId: department.id } }))
              )
          }))
  })
  const names = departments
    .filter((department, index) =>
      member.kind === 'agent'
        ? member.agent.departmentIds.includes(department.id)
        : department.headUserId === member.id ||
          details[index]?.data?.members.some(
            (entry) => entry.memberKind === 'user' && entry.memberId === member.id
          )
    )
    .map((department) => department.name)
  return names.length === 0 ? null : (
    <p className="text-xs text-muted-foreground">{names.join(' · ')}</p>
  )
}

/** The same existing member details and actions on avatars, names, and mentions. */
export function MemberProfileCard({
  member,
  onDone,
  onHuddle,
  details
}: {
  member: Mentionable
  onDone?: () => void
  onHuddle: (channelId: ChannelId) => void
  details?: React.ReactNode
}) {
  const navigate = useNavigate()
  const me = useMe().data
  const openDm = useOpenDm()
  const huddle = useHuddle()
  const presence = usePresence(member.id, member.defaultPresence)
  const agent = member.kind === 'agent' ? member.agent : undefined
  const agentDetail = useAgent(agent?.id)
  const skills = agentDetail.data?.skills.filter((skill) => skill.state === 'active')
  const isSelf = member.kind === 'user' && member.id === me?.user.id

  const message = (startHuddle = false): void => {
    if (isSelf) return
    openDm.mutate(
      { memberKind: member.kind, memberId: member.id },
      {
        onSuccess: (channel) => {
          if (startHuddle) onHuddle(channel.id)
          else {
            onDone?.()
            void navigate({ to: '/dm/$channelId', params: { channelId: channel.id } })
          }
        }
      }
    )
  }
  const configure = (): void => {
    if (agent === undefined) return
    onDone?.()
    void navigate({ to: '/agents/$agentId', params: { agentId: agent.id } })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            agent === undefined
              ? isSelf
                ? `${member.name}'s profile`
                : `Message ${member.name}`
              : `Configure ${member.name}`
          }
          disabled={isSelf || openDm.isPending}
          onClick={() => (agent === undefined ? message() : configure())}
        >
          <AvatarVisual
            avatar={member.avatar}
            kind={member.kind}
            face={member.face}
            name={member.name}
            presence={presence}
            size="xl"
            compacting={false}
            contextPercentage={0}
          />
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold break-words">{member.name}</p>
          <p className="text-xs text-muted-foreground break-words">
            {agent?.role || member.subtitle}
          </p>
          <MemberDepartments member={member} />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <PresenceDot presence={presence} />
            {presenceLabel(presence)}
          </p>
        </div>
      </div>
      {member.kind === 'user' ? (
        <a
          href={`mailto:${member.email}`}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:underline"
        >
          <MailIcon className="size-3.5 shrink-0" />
          <span className="truncate">{member.email}</span>
        </a>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium">Skills</p>
          {agentDetail.isError ? (
            <p className="text-xs text-muted-foreground">Skills unavailable</p>
          ) : skills === undefined ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading skills…
            </p>
          ) : skills.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active skills</p>
          ) : (
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
              {skills.map((skill) => (
                <Badge
                  key={skill.name}
                  variant="secondary"
                  className="max-w-full whitespace-normal break-words"
                  title={skill.description}
                >
                  {skill.name}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
      {details === undefined ? null : <div className="border-t pt-3">{details}</div>}
      {isSelf ? null : (
        <div className="flex gap-2 border-t pt-3">
          {agent === undefined ? (
            <>
              <Button
                size="sm"
                className="flex-1"
                disabled={openDm.isPending}
                onClick={() => message()}
              >
                <MessageSquareIcon />
                Message
              </Button>
              {!isSelf && huddle.enabled ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={openDm.isPending || huddle.joining !== undefined}
                  onClick={() => message(true)}
                >
                  <HeadphonesIcon />
                  Huddle
                </Button>
              ) : null}
            </>
          ) : (
            <Button asChild size="sm" variant="outline" className="w-full">
              <Link to="/agents/$agentId" params={{ agentId: agent.id }} onClick={() => onDone?.()}>
                <SettingsIcon />
                Configure agent
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** Hover/focus opens details; activation goes straight to the member's destination. */
function ProfileTrigger({
  member,
  children,
  className,
  onNavigate
}: {
  member: Mentionable
  children: React.ReactNode
  className?: string | undefined
  onNavigate?: (() => void) | undefined
}) {
  const [open, setOpen] = React.useState(false)
  const [huddleChannel, setHuddleChannel] = React.useState<ChannelId>()
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const anchor = React.useRef<HTMLSpanElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const openDm = useOpenDm()
  const me = useMe().data
  const isSelf = member.kind === 'user' && member.id === me?.user.id
  const { details } = React.useContext(AvatarContext)
  const clearTimer = (): void => {
    clearTimeout(timer.current)
  }
  React.useEffect(() => () => clearTimeout(timer.current), [])
  const show = (): void => {
    clearTimer()
    timer.current = setTimeout(() => setOpen(true), 250)
  }
  const hide = (): void => {
    clearTimer()
    timer.current = setTimeout(() => {
      const focused = document.activeElement
      if (!anchor.current?.contains(focused) && !content.current?.contains(focused)) setOpen(false)
    }, 180)
  }
  const close = (): void => {
    clearTimer()
    setOpen(false)
  }
  const done = (): void => {
    close()
    onNavigate?.()
  }
  const activate = (): void => {
    if (isSelf) {
      clearTimer()
      setOpen(true)
      return
    }
    close()
    if (member.kind === 'agent') {
      onNavigate?.()
      void navigate({ to: '/agents/$agentId', params: { agentId: member.id } })
    } else if (!openDm.isPending) {
      openDm.mutate(
        { memberKind: 'user', memberId: member.id },
        {
          onSuccess: (channel) => {
            onNavigate?.()
            void navigate({ to: '/dm/$channelId', params: { channelId: channel.id } })
          }
        }
      )
    }
  }
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(value) => {
          clearTimer()
          setOpen(value)
        }}
      >
        <PopoverAnchor asChild>
          <span
            ref={anchor}
            role="button"
            tabIndex={0}
            aria-label={
              member.kind === 'agent'
                ? `Configure ${member.name}`
                : isSelf
                  ? `View ${member.name}'s profile`
                  : `Message ${member.name}`
            }
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-busy={openDm.isPending || undefined}
            className={cn(
              'inline-flex shrink-0 cursor-pointer rounded-md align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className
            )}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') show()
            }}
            onPointerLeave={hide}
            onFocus={() => {
              clearTimer()
              setOpen(true)
            }}
            onBlur={hide}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              activate()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && !event.shiftKey && open) {
                const firstAction = content.current?.querySelector<HTMLElement>(
                  'button:not(:disabled), a[href]'
                )
                if (firstAction !== undefined && firstAction !== null) {
                  event.preventDefault()
                  event.stopPropagation()
                  firstAction.focus()
                }
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                activate()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
              }
            }}
          >
            {children}
          </span>
        </PopoverAnchor>
        <PopoverContent
          ref={content}
          align="start"
          sideOffset={8}
          className="w-80 rounded-xl p-4"
          aria-label={`${member.name}'s profile`}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            anchor.current?.focus({ preventScroll: true })
            close()
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={clearTimer}
          onPointerLeave={hide}
          onFocus={clearTimer}
          onBlur={hide}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MemberProfileCard
            member={member}
            details={details}
            onDone={done}
            onHuddle={(channelId) => {
              close()
              setHuddleChannel(channelId)
            }}
          />
        </PopoverContent>
      </Popover>
      {huddleChannel === undefined ? null : (
        <HuddlePrejoin
          channelId={huddleChannel}
          open
          onOpenChange={(value) => {
            if (!value) setHuddleChannel(undefined)
          }}
        />
      )}
    </>
  )
}

export function MemberProfileTrigger({
  memberId,
  children,
  className,
  onNavigate
}: {
  memberId: string | undefined
  children: React.ReactNode
  className?: string | undefined
  onNavigate?: (() => void) | undefined
}) {
  const directory = useDirectoryIndex()
  const member = memberId === undefined ? undefined : directory.get(memberId)
  return member === undefined ? (
    <>{children}</>
  ) : (
    <ProfileTrigger member={member} className={className} onNavigate={onNavigate}>
      {children}
    </ProfileTrigger>
  )
}

export function ProfilePopover({
  handle,
  className,
  children
}: {
  handle: string
  className?: string
  children: React.ReactNode
}) {
  const member = useLookupHandle()(handle)
  return member === undefined ? (
    <>{children}</>
  ) : (
    <ProfileTrigger member={member} className={className}>
      {children}
    </ProfileTrigger>
  )
}
