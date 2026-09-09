import * as React from 'react'
import {
  HeadphonesIcon,
  Loader2Icon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  PhoneOffIcon,
  VideoIcon,
  VideoOffIcon
} from 'lucide-react'
import type { ChannelId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@taut/ui/components/tooltip'
import { cn } from '@taut/ui/lib/utils'

import { EntityAvatar } from '@/components/entity-avatar'
import { HuddlePrejoin } from '@/components/huddle-prejoin'
import { useChannel, useDmView, useLookupMember } from '@/hooks/use-directory'
import { useChannelCall, useElsewhereCall, useHuddle } from '@/hooks/use-huddle'
import { desktop, huddlePath } from '@/lib/desktop'
import type { HuddleParticipant } from '@/lib/livekit'

/** One person in the room. The ring is the only thing that moves while people talk. */
function Speaker({ participant }: { participant: HuddleParticipant }) {
  const lookup = useLookupMember()
  const member = lookup(participant.memberId)
  const name = member?.name ?? participant.name

  return (
    <span
      title={participant.local ? `${name} (you)` : name}
      className={cn(
        'relative inline-flex rounded-md p-0.5 ring-2 transition-colors',
        participant.speaking ? 'ring-emerald-500' : 'ring-transparent'
      )}
    >
      <EntityAvatar
        avatar={member?.avatar}
        kind={participant.kind}
        face={member?.face}
        name={name}
        size="sm"
      />
      {participant.micMuted ? (
        <span className="absolute -right-1 -bottom-1 rounded-full bg-background p-px text-muted-foreground">
          <MicOffIcon className="size-2.5" />
        </span>
      ) : null}
    </span>
  )
}

function BarButton({
  label,
  active = false,
  disabled = false,
  destructive = false,
  onClick,
  children
}: {
  label: string
  active?: boolean
  disabled?: boolean
  destructive?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={destructive ? 'destructive' : active ? 'secondary' : 'ghost'}
          aria-label={label}
          aria-pressed={destructive ? undefined : active}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The docked huddle strip (docs/build-plan-calls.md D13). Mounted by the app shell, so it
 * outlives the route that started the call, and rendered at all only while this tab is in
 * a huddle — a company without LiveKit configured never sees it (D3).
 */
export function HuddleBar() {
  const { enabled, call, room, leave } = useHuddle()
  const channel = useChannel(call?.channelId)
  const dm = useDmView(call?.channelId)

  if (!enabled || call === undefined) return null

  const label =
    channel?.kind === 'dm'
      ? (dm?.partner?.name ?? dm?.label ?? 'Direct message')
      : `#${channel?.name ?? 'huddle'}`

  const status =
    room.connection === 'connected'
      ? undefined
      : room.connection === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…'

  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-sidebar px-4 py-2 text-sidebar-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <HeadphonesIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">{label}</span>
        {status === undefined ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
        )}
      </div>

      <div className="taut-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {room.participants.map((participant) => (
          <Speaker key={participant.identity} participant={participant} />
        ))}
      </div>

      <HuddleControls onLeave={leave} />
    </div>
  )
}

/**
 * Mic, screen share, camera, leave. Exported because the huddle window renders the same four
 * buttons under the room (docs/build-plan-huddle-window.md D4) — a second copy would be a
 * second place to forget `micDenied`.
 *
 * `onLeave` exists because leaving means something different in the shell's huddle window:
 * there, the window goes with it (D13).
 */
export function HuddleControls({ onLeave }: { onLeave: () => void }) {
  const { room, toggleMic, toggleCamera, toggleScreenShare } = useHuddle()

  return (
    <div className="flex shrink-0 items-center gap-1">
      <BarButton
        label={
          room.micDenied
            ? 'Microphone unavailable — you are listening only'
            : room.micEnabled
              ? 'Mute'
              : 'Unmute'
        }
        active={room.micEnabled}
        disabled={room.micDenied}
        onClick={toggleMic}
      >
        {room.micEnabled ? <MicIcon /> : <MicOffIcon />}
      </BarButton>

      <BarButton
        label={room.screenShareEnabled ? 'Stop sharing' : 'Share screen'}
        active={room.screenShareEnabled}
        onClick={toggleScreenShare}
      >
        <MonitorUpIcon />
      </BarButton>

      {/* Camera is off until asked for, and stays a toggle rather than a mode (D16). */}
      <BarButton
        label={room.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
        active={room.cameraEnabled}
        onClick={toggleCamera}
      >
        {room.cameraEnabled ? <VideoIcon /> : <VideoOffIcon />}
      </BarButton>

      <BarButton label="Leave huddle" destructive onClick={onLeave}>
        <PhoneOffIcon />
      </BarButton>
    </div>
  )
}

/**
 * The channel and DM header entry point. One huddle per channel (D1), so there is no "start"
 * next to "join": the same button opens the room or walks into the one already running.
 */
export function HuddleButton({ channelId }: { channelId: ChannelId }) {
  const { enabled, call, joining, leave } = useHuddle()
  const open = useChannelCall(channelId)
  // D1: the button no longer joins anything. It opens the dialog, and the dialog decides.
  const [prejoin, setPrejoin] = React.useState(false)

  if (!enabled) return null

  const here = call?.channelId === channelId
  const busy = joining === channelId
  const count = open?.participants.length ?? 0

  return (
    <>
      <Button
        variant={here ? 'secondary' : 'ghost'}
        size="sm"
        disabled={busy}
        onClick={() => (here ? leave() : setPrejoin(true))}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : <HeadphonesIcon />}
        {here ? 'Leave' : count > 0 ? `Join · ${count}` : 'Huddle'}
      </Button>
      <HuddlePrejoin channelId={channelId} open={prejoin} onOpenChange={setPrejoin} />
    </>
  )
}

/**
 * "Return to huddle", in the shell's main window only (D7).
 *
 * The main window never holds a room, so what it knows about the call comes from the server's
 * participant list (calls D2) rather than from LiveKit. Its button re-points the huddle window
 * at the same path, which focuses the one already open rather than making another (D13);
 * leaving is done in the window that is actually in the call.
 */
export function HuddleReturnBar() {
  const call = useElsewhereCall()
  const channel = useChannel(call?.channelId)
  const dm = useDmView(call?.channelId)

  if (call === undefined) return null

  const label =
    channel?.kind === 'dm'
      ? (dm?.partner?.name ?? dm?.label ?? 'Direct message')
      : `#${channel?.name ?? 'huddle'}`

  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-sidebar px-4 py-2 text-sidebar-foreground">
      <HeadphonesIcon className="size-4 shrink-0 text-emerald-500" />
      <span className="min-w-0 truncate text-xs font-medium">You are in a huddle in {label}</span>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto"
        onClick={() =>
          desktop?.openHuddle(huddlePath(call.channelId, { mic: true, camera: false }))
        }
      >
        Return to huddle
      </Button>
    </div>
  )
}
