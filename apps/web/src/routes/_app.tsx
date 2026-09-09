import * as React from 'react'
import { Outlet, createFileRoute, redirect, useParams } from '@tanstack/react-router'
import type { Me } from '@taut/contract'

import { SidebarInset, SidebarProvider } from '@taut/ui/components/sidebar'

import { AppSidebar } from '@/components/app-sidebar'
import { CommandPaletteProvider } from '@/components/command-palette'
import { HuddleBar, HuddleReturnBar } from '@/components/huddle-bar'
import { HuddleInvites } from '@/components/huddle-invite'
import { HuddleRoomPanel } from '@/components/huddle-room'
import { useDesktopNavigation } from '@/hooks/use-desktop'
import { HuddleProvider } from '@/hooks/use-huddle'
import { useRealtime } from '@/hooks/use-realtime'
import { meQueryOptions, useLiveRunSeed } from '@/lib/api'
import { call } from '@/lib/api-client'
import { qk } from '@/lib/query-keys'
import { runEffect } from '@/lib/runtime'
import { armSounds } from '@/lib/sounds'

/** The authenticated shell: one collapsible sidebar plus the main pane. */
function AppLayout() {
  const params = useParams({ strict: false })
  const channelId = typeof params.channelId === 'string' ? params.channelId : undefined
  const { status, lastSeq } = useRealtime(channelId)
  // Seeds which messages shimmer, so a refresh mid-run does not leave them flat (D9).
  useLiveRunSeed()
  useDesktopNavigation()
  // Browsers refuse audio before a gesture, so the elements are primed on the first one (D10).
  React.useEffect(armSounds, [])

  return (
    <CommandPaletteProvider>
      {/* The huddle outlives the route that started it, so it is mounted by the shell (D13). */}
      <HuddleProvider>
        <SidebarProvider className="taut-shell h-full overflow-hidden bg-background text-foreground">
          <AppSidebar connection={status} lastSeq={lastSeq} />
          <SidebarInset className="min-h-0 overflow-hidden">
            <Outlet />
            {/* One tree, mounted inline here and as a whole page in the huddle window (D4). */}
            <HuddleRoomPanel layout="inline" />
            <HuddleBar />
            {/* Only ever visible in the shell's main window, which holds no room (D7). */}
            <HuddleReturnBar />
            <HuddleInvites />
          </SidebarInset>
        </SidebarProvider>
      </HuddleProvider>
    </CommandPaletteProvider>
  )
}

export const Route = createFileRoute('/_app')({
  /**
   * No session → `/login`. A session with no company at all → `/onboarding`.
   * A session that simply has not picked one yet adopts its first membership.
   */
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
  component: AppLayout
})
