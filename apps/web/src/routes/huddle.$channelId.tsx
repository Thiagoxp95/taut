import * as React from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ArrowLeftIcon, HeadphonesIcon } from '@taut/ui/components/icons'
import type { ChannelId, Me } from '@taut/contract'
import { Button } from '@taut/ui/components/button'

import { HuddleRoomPanel } from '@/components/huddle-room'
import { useChannel, useDmView } from '@/hooks/use-directory'
import { HuddleProvider, useHuddle } from '@/hooks/use-huddle'
import { useRealtime } from '@/hooks/use-realtime'
import { meQueryOptions } from '@/lib/api'
import { call } from '@/lib/api-client'
import { closeHuddleWindow, desktop } from '@/lib/desktop'
import { parseChannelId } from '@/lib/ids'
import { qk } from '@/lib/query-keys'
import { armSounds } from '@/lib/sounds'
import { runEffect } from '@/lib/runtime'

/** `?mic=&cam=`, as `openHuddle` was handed them (docs/build-plan-huddle-window.md D6). */
export interface HuddleWindowSearch {
  readonly mic: boolean
  readonly cam: boolean
}

/**
 * The huddle window's page (D6). Deliberately not under `_app`: no sidebar, no command
 * palette, no channel — a second renderer whose whole job is one room and its thread.
 *
 * It runs the realtime socket of its own, because the thread below the tiles has to live-update
 * while people talk, and the main window's socket belongs to a different renderer.
 */
function HuddleWindow({
  channelId,
  mic,
  camera
}: {
  channelId: ChannelId | undefined
  mic: boolean
  camera: boolean
}) {
  const { enabled, call, join, room } = useHuddle()
  const channel = useChannel(channelId)
  const dm = useDmView(channelId)
  useRealtime(channelId)

  // `_app` arms the sounds for the main window; this route is not under it, and this is the
  // window huddles actually happen in — pop-in and pop-out come from here.
  React.useEffect(armSounds, [])

  // This window *is* the join (D6): it connects once, on arrival, with the intent the dialog
  // in the main window put in the URL.
  const joined = React.useRef(false)
  React.useEffect(() => {
    if (!enabled || channelId === undefined || joined.current) return
    joined.current = true
    join(channelId, { mic, camera })
  }, [enabled, channelId, join, mic, camera])

  /*
   * The window exists for one call, so it goes when the call does: pressing Leave, the last
   * person leaving, or LiveKit evicting this connection because the same person joined from
   * a second device (calls D6). Guarded on having actually been in the room, or the window
   * would close itself in the moment between mounting and connecting.
   */
  const wasIn = React.useRef(false)
  React.useEffect(() => {
    if (call !== undefined) {
      wasIn.current = true
      return
    }
    if (!wasIn.current) return
    closeHuddleWindow()
  }, [call])

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
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="taut-topbar flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <HeadphonesIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        {status === undefined ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
        )}
        {/* The main window is where the rest of Taut is; this one keeps the call (D12). */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to Taut"
          className="ml-auto"
          onClick={() => desktop?.focusMain()}
        >
          <ArrowLeftIcon />
        </Button>
      </header>

      {enabled ? (
        <HuddleRoomPanel layout="window" />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          Huddles are not configured on this deployment.
        </p>
      )}
    </div>
  )
}

function HuddleWindowRoute() {
  const { channelId } = Route.useParams()
  const { mic, cam } = Route.useSearch()

  // A fresh provider: this renderer holds the room, and the main window holds none (D6).
  return (
    <HuddleProvider>
      <HuddleWindow channelId={parseChannelId(channelId)} mic={mic} camera={cam} />
    </HuddleProvider>
  )
}

export const Route = createFileRoute('/huddle/$channelId')({
  /** The same gate as the app shell: no session → `/login`, no company → `/onboarding`. */
  beforeLoad: async ({ context }) => {
    let me: Me
    try {
      me = await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login' })
    }

    if (me.activeCompanyId !== undefined) return

    const first = me.memberships[0]
    if (first === undefined) throw redirect({ to: '/onboarding' })

    await runEffect(call((api) => api.companies.switch({ path: { companyId: first.company.id } })))
    await context.queryClient.invalidateQueries({ queryKey: qk.me })
    await context.queryClient.ensureQueryData(meQueryOptions)
  },
  /** Absent means the defaults the bar's "Return to huddle" uses: mic on, camera off. */
  validateSearch: (search: Record<string, unknown>): HuddleWindowSearch => ({
    mic: search['mic'] !== '0',
    cam: search['cam'] === '1'
  }),
  component: HuddleWindowRoute
})
