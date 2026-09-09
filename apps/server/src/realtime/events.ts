import type { Event } from '@taut/contract/events'
import type { ChannelId, CompanyId, MessageId, UserId } from '@taut/contract/ids'

/** What travels on the in-process `Bus`. Typing is ephemeral: broadcast only, never logged. */
export type BusMessage =
  | { readonly _tag: 'Event'; readonly companyId: CompanyId; readonly event: Event }
  | {
      readonly _tag: 'Typing'
      readonly companyId: CompanyId
      readonly channelId: ChannelId
      readonly threadId?: MessageId | undefined
      readonly userId: UserId
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
