import * as React from 'react'
import { MonitorUpIcon } from '@taut/ui/components/icons'
import { cn } from '@taut/ui/lib/utils'

import { useHuddle } from '@/hooks/use-huddle'
import { useLookupMember } from '@/hooks/use-directory'
import type { HuddleVideo } from '@/lib/livekit'

/**
 * The picture half of a huddle: every screen share and every camera in the room, in one grid
 * (docs/build-plan-calls.md D15/D16). It appears only when somebody is actually publishing —
 * the bar alone is the whole UI for a voice-only huddle, which is most of them.
 *
 * No speaker view, no pinning, no layout switching. // TODO(plan)
 */
function Tile({ video, label }: { video: HuddleVideo; label: string }) {
  const ref = React.useRef<HTMLVideoElement>(null)

  React.useEffect(() => {
    const element = ref.current
    if (element === null) return
    // `attach` hands back its own undo, and the wrapper keeps one `HuddleVideo` per track,
    // so this runs once per track rather than once per room event.
    return video.attach(element)
  }, [video])

  return (
    <div className="relative min-w-0 overflow-hidden rounded-lg border bg-black">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={cn(
          'h-full w-full bg-black object-contain',
          // A camera is a face: mirrored reads as a mirror, a screen must not be.
          video.source === 'camera' && '-scale-x-100'
        )}
      />
      <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
        {video.source === 'screen' ? <MonitorUpIcon className="size-3" /> : null}
        {label}
      </span>
    </div>
  )
}

/**
 * `className` replaces the docked strip's own height and border, so the huddle window can let
 * the grid fill it (docs/build-plan-huddle-window.md D4) without a second copy of this file.
 */
export function HuddleTiles({ className }: { className?: string }) {
  const { enabled, call, room } = useHuddle()
  const lookup = useLookupMember()

  const tiles = React.useMemo(
    () =>
      room.participants.flatMap((participant) => {
        const name = lookup(participant.memberId)?.name ?? participant.name
        const own: { key: string; video: HuddleVideo; label: string }[] = []
        if (participant.screen !== undefined) {
          own.push({
            key: participant.screen.sid,
            video: participant.screen,
            label: `${name}'s screen`
          })
        }
        if (participant.camera !== undefined) {
          own.push({ key: participant.camera.sid, video: participant.camera, label: name })
        }
        return own
      }),
    [room.participants, lookup]
  )

  if (!enabled || call === undefined || tiles.length === 0) return null

  return (
    <div
      className={cn(
        'grid h-[min(38vh,320px)] shrink-0 gap-2 border-t bg-muted/40 p-2',
        // One share fills the strip; more of them share it, two across at most.
        tiles.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
        className
      )}
    >
      {tiles.map((tile) => (
        <Tile key={tile.key} video={tile.video} label={tile.label} />
      ))}
    </div>
  )
}
