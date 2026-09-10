import type { Event } from '@taut/contract/events'
import type { AgentId, ChannelId, CompanyId, MessageId, TaskId, UserId } from '@taut/contract/ids'

/**
 * What travels on the in-process `Bus`. Typing and Activity are ephemeral: broadcast only,
 * never logged (docs/build-plan-activity.md D2).
 */
export type BusMessage =
  | { readonly _tag: 'Event'; readonly companyId: CompanyId; readonly event: Event }
  | {
      readonly _tag: 'Typing'
      readonly companyId: CompanyId
      readonly channelId: ChannelId
      readonly threadId?: MessageId | undefined
      readonly userId: UserId
    }
  | {
      readonly _tag: 'Activity'
      readonly companyId: CompanyId
      readonly channelId: ChannelId
      readonly threadId: MessageId
      readonly taskId: TaskId
      readonly messageId: MessageId
      readonly agentId: AgentId
      readonly kind: 'thinking' | 'tool'
      readonly text: string
      readonly browser?: boolean
    }

/**
 * Events addressed to one user (agent-model.md §8 "fan-out target: one user").
 * The log is per company, so `WsServer` filters these per socket.
 */
export const isVisibleTo = (event: Event, userId: UserId): boolean => {
  switch (event.type) {
    case 'notification':
      return event.payload.notification.userId === userId
    case 'unread.changed':
      return event.payload.userId === userId
    default:
      return true
  }
}
