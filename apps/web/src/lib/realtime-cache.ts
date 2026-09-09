/**
 * One `Event` in, one surgical cache edit out.
 *
 * Lists are invalidated (cheap, rare); message streams are patched in place
 * (hot path — a streaming agent reply must not refetch 50 messages per delta).
 */
import type { QueryClient } from '@tanstack/react-query'
import type { Call, CallId, ChannelId, Event, NotificationKind } from '@taut/contract'
import { toast } from '@taut/ui/components/sonner'

import { isDesktop } from '@/lib/desktop'
import { live } from '@/lib/live'
import { addMessage, appendToMessage, removeMessage, updateMessage } from '@/lib/message-cache'
import { qk } from '@/lib/query-keys'
import { playSound } from '@/lib/sounds'

export interface RealtimeContext {
  readonly queryClient: QueryClient
  readonly currentUserId: string | undefined
  /** `@handle` of the current user, so a mention can bump the mention badge. */
  readonly currentUserHandle: string | undefined
  /** The channel the user is looking at right now, if any. */
  readonly currentChannelId: string | undefined
  /** `true` while the tab has focus, so we only auto-read what is really read. */
  readonly focused: boolean
  readonly onRead: (channelId: ChannelId) => void
}

const NOTIFICATION_TITLE: Record<NotificationKind, string> = {
  mention: 'You were mentioned',
  dm: 'New direct message',
  thread_reply: 'New reply in a thread you are in',
  agent_done: 'An agent finished',
  agent_failed: 'An agent run failed',
  huddle: 'A huddle started'
}

/**
 * `call.updated` carries the whole call (docs/build-plan-calls.md D2), so the active list is
 * a replace-by-id: a client that missed an event converges on the next one it does see.
 * A miss on a cold cache is harmless — the query has not loaded yet and will fetch the truth.
 */
const upsertCall = (queryClient: QueryClient, call: Call): void => {
  queryClient.setQueryData<readonly Call[]>(qk.activeCalls, (current) => {
    if (current === undefined) return current
    const rest = current.filter((entry) => entry.id !== call.id)
    return call.endedAt === undefined ? [...rest, call] : rest
  })
}

const removeCall = (queryClient: QueryClient, callId: CallId): void => {
  queryClient.setQueryData<readonly Call[]>(qk.activeCalls, (current) =>
    current?.filter((entry) => entry.id !== callId)
  )
}

const mentionsMe = (body: string, handle: string | undefined): boolean =>
  handle !== undefined && new RegExp(`@${handle}\\b`, 'i').test(body)

export function applyRealtimeEvent(event: Event, context: RealtimeContext): void {
  const { queryClient } = context
  const invalidate = (key: readonly unknown[]): void => {
    void queryClient.invalidateQueries({ queryKey: key })
  }

  switch (event.type) {
    case 'message.created': {
      const { message } = event.payload
      live.rememberSeq(event.seq, message.channelId)
      addMessage(queryClient, message)

      const isCurrent = message.channelId === context.currentChannelId
      const isMine =
        message.authorKind === 'user' && message.authorId === (context.currentUserId ?? '')

      if (isCurrent && context.focused) {
        context.onRead(message.channelId)
      } else if (!isMine) {
        live.bumpUnread(message.channelId, mentionsMe(message.body, context.currentUserHandle))
      }
      return
    }

    case 'message.updated':
      updateMessage(queryClient, event.payload.message)
      return

    case 'message.deleted':
      removeMessage(queryClient, event.payload.messageId)
      return

    case 'agent.task.started':
      live.rememberSeq(event.seq, event.payload.message.channelId)
      addMessage(queryClient, event.payload.message)
      live.setPresence(event.payload.task.agentId, 'working')
      // The message that invoked the agent shimmers until this run ends (build-plan-shimmer D2).
      live.startRun(event.payload.task.triggerMessageId, event.payload.task.id)
      invalidate(qk.tasks)
      return

    case 'agent.task.delta':
      appendToMessage(queryClient, event.payload.messageId, event.payload.delta)
      return

    // The ring around that agent's avatar, in that thread only
    // (docs/build-plan-context-meter.md D10).
    case 'agent.context.updated':
      live.setThreadContext(event.payload)
      return

    case 'agent.task.done':
      updateMessage(queryClient, event.payload.message)
      live.setPresence(event.payload.task.agentId, 'idle')
      live.endRun(event.payload.task.id)
      invalidate(qk.tasks)
      return

    case 'agent.task.failed':
      updateMessage(queryClient, event.payload.message)
      live.setMessageError(event.payload.message.id, event.payload.error)
      live.setPresence(event.payload.task.agentId, 'idle')
      live.endRun(event.payload.task.id)
      invalidate(qk.tasks)
      return

    case 'task.updated':
      invalidate(qk.tasks)
      return

    case 'typing':
      if (event.payload.userId !== context.currentUserId) {
        live.markTyping(event.payload.channelId, event.payload.userId)
      }
      return

    case 'presence.changed':
      live.setPresence(event.payload.memberId, event.payload.state)
      return

    case 'unread.changed':
      if (event.payload.userId === context.currentUserId) {
        live.setUnread(event.payload.channelId, {
          unread: event.payload.unread,
          mentions: event.payload.mentions
        })
      }
      return

    case 'notification': {
      const { notification } = event.payload
      if (notification.userId !== context.currentUserId) return
      const channelId = live.channelForSeq(notification.eventSeq)
      // A notification about the channel already on screen is just noise.
      if (channelId !== undefined && channelId === context.currentChannelId) return
      /*
       * The pop, for something addressed to this user and only this user
       * (docs/build-plan-huddle-window.md D10). A huddle invite is exempt: it already rings
       * (D11), and two sounds for one event is one too many.
       *
       * The shell plays it too, and its OS notification is raised `silent` for exactly this
       * reason: the owner chose this sound, so it is the one that must be heard on every
       * platform rather than whatever the system banner would otherwise play.
       */
      if (notification.kind !== 'huddle') playSound('pop')
      // The toast is the shell's one exemption — an OS banner is already on screen.
      if (!isDesktop) toast(NOTIFICATION_TITLE[notification.kind])
      return
    }

    case 'membership.created':
    case 'membership.updated':
    case 'membership.deleted':
      invalidate(qk.members)
      return

    case 'company.updated':
      invalidate(qk.companies)
      invalidate(qk.me)
      return

    case 'department.created':
    case 'department.updated':
    case 'department.deleted':
      invalidate(qk.departments)
      // `Agent.departmentIds` follows department membership.
      invalidate(qk.agents)
      return

    case 'channel.created':
    case 'channel.updated':
    case 'channel.deleted':
      invalidate(qk.channels)
      void queryClient.invalidateQueries({ queryKey: ['channel-members'] })
      return

    case 'agent.created':
    case 'agent.updated':
    case 'agent.deleted':
      invalidate(qk.agents)
      return

    case 'agent.skill.changed': {
      // An install, an approval, a policy change, or an upstream update the daily check found
      // (docs/build-plan-skills.md D13). The agent detail carries the skill list.
      const { skill } = event.payload
      invalidate(qk.agents)
      void queryClient.invalidateQueries({ queryKey: qk.skill(skill.agentId, skill.name) })
      return
    }

    case 'agent.skill.removed':
      invalidate(qk.agents)
      void queryClient.invalidateQueries({
        queryKey: qk.skill(event.payload.agentId, event.payload.name)
      })
      return

    case 'vault.item.created':
    case 'vault.item.updated':
    case 'vault.item.revoked':
      // A prefix, so the company list and every agent-scoped list are refetched.
      invalidate(qk.allVaults)
      // A revoked credential takes its seats with it (docs/agent-model.md §3).
      invalidate(qk.subscriptions)
      return

    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.deleted':
      invalidate(qk.subscriptions)
      return

    case 'call.started':
    case 'call.updated':
      upsertCall(queryClient, event.payload.call)
      return

    case 'call.ended':
      removeCall(queryClient, event.payload.callId)
      return

    case 'project.synced':
    case 'project.changed':
    case 'project.linear.changed':
    case 'project.linear.member.changed':
      // A prefix: a sync replaces the whole mirror, and the connection row moved
      // with it (docs/build-plan-projects.md D6). The people mapping hangs off the
      // same prefix, so a remapping lands here too (D16).
      invalidate(qk.projects)
      return

    case 'routine.created':
    case 'routine.updated':
    case 'routine.deleted':
      // A prefix: every tick stamps `nextRunAt`, and the row that moved may be in any list.
      invalidate(qk.routines)
      return

    case 'signal.emitted':
      /*
       * A wake went off (docs/build-plan-triggers.md D16). The row under the thread composer
       * lists what is still pending, so the signal that just fired has to leave it. The wake
       * message itself arrives on its own `message.created`, so nothing else needs touching.
       */
      invalidate(qk.signals)
      return
  }
}
