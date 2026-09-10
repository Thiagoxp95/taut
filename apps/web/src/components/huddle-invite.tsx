import * as React from 'react'
import { HeadphonesIcon, PhoneOffIcon } from '@taut/ui/components/icons'
import type { Call, CallId, ChannelId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'

import { EntityAvatar } from '@/components/entity-avatar'
import { HuddlePrejoin } from '@/components/huddle-prejoin'
import { useDmView } from '@/hooks/use-directory'
import { useHuddleInvites } from '@/hooks/use-huddle'

/** One ringing DM huddle (docs/build-plan-huddle-window.md D11). */
function InviteCard({
  call,
  onJoin,
  onDecline
}: {
  call: Call
  onJoin: () => void
  onDecline: () => void
}) {
  const dm = useDmView(call.channelId)
  const partner = dm?.partner
  const name = partner?.name ?? dm?.label ?? 'Someone'

  return (
    <div className="flex w-80 items-center gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
      <EntityAvatar
        memberId={partner?.id}
        avatar={partner?.avatar}
        kind={partner?.kind ?? 'user'}
        face={partner?.face}
        name={name}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">is starting a huddle</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Decline"
          className="text-muted-foreground"
          onClick={onDecline}
        >
          <PhoneOffIcon />
        </Button>
        <Button
          size="sm"
          aria-label="Join huddle"
          className="bg-emerald-600 text-white hover:bg-emerald-600/90"
          onClick={onJoin}
        >
          <HeadphonesIcon />
          Join
        </Button>
      </div>
    </div>
  )
}

/**
 * The ringing corner (D11). Mounted by the app shell in the main window only — the huddle
 * window is already in a call and has nothing to answer.
 *
 * Join takes the ordinary pre-join path (D1) rather than connecting straight away, so the
 * person who answers still picks a camera and a microphone. Decline is local: it stops the
 * ring and hides the card, and the server is never told — the caller sees nobody joined, which
 * is what a missed call looks like anyway (`// TODO(plan)`: a declined state on the server).
 */
export function HuddleInvites() {
  const { invites, dismiss } = useHuddleInvites()
  const [answering, setAnswering] = React.useState<ChannelId | undefined>(undefined)

  const answer = React.useCallback(
    (callId: CallId, channelId: ChannelId): void => {
      // Answering silences this invite the same way declining does; the dialog takes over.
      dismiss(callId)
      setAnswering(channelId)
    },
    [dismiss]
  )

  return (
    <>
      {invites.length === 0 ? null : (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
          {invites.map((invite) => (
            <InviteCard
              key={invite.call.id}
              call={invite.call}
              onJoin={() => answer(invite.call.id, invite.channelId)}
              onDecline={() => dismiss(invite.call.id)}
            />
          ))}
        </div>
      )}
      {answering === undefined ? null : (
        <HuddlePrejoin
          channelId={answering}
          open
          onOpenChange={(next) => {
            if (!next) setAnswering(undefined)
          }}
        />
      )}
    </>
  )
}
