/**
 * Huddles (docs/build-plan-calls.md). A `Call` is one live LiveKit room bound to one channel:
 * starting a huddle and joining it are the same operation, so at most one call per channel is
 * open at a time (D1) and its room name is always derived from the channel id.
 *
 * Who is in the room is decided by LiveKit's webhooks, not by the browser (D2) — `participants`
 * is what the server last heard from the SFU, so it survives a crashed tab or a closed laptop.
 */
import { Schema } from 'effect'

import { CallId, ChannelId, CompanyId, MemberId, MessageId } from '../ids.js'
import { MemberKind } from './enums.js'

/** LiveKit room name for a channel's huddle — the only naming rule (D1). */
export const huddleRoom = (channelId: ChannelId): string => `huddle_${channelId}`

/**
 * LiveKit participant identity. `user:usr_…` today; `agent:agt_…` is reserved so agents can
 * join without an identity re-scheme (D5).
 */
export const participantIdentity = (kind: MemberKind, id: MemberId): string => `${kind}:${id}`

/** One member currently in a huddle. */
export class CallParticipant extends Schema.Class<CallParticipant>('CallParticipant')({
  kind: MemberKind,
  id: MemberId,
  joinedAt: Schema.DateTimeUtc,
  /** Publishing a screen-share track right now (D15). */
  sharing: Schema.Boolean
}) {}

/**
 * One huddle. `endedAt` is set when the last participant leaves; `participants` lists everyone
 * still in the room, in join order. Same wire trick as `Message.attachments`: absent-or-array
 * on the wire, always an array in memory.
 */
export class Call extends Schema.Class<Call>('Call')({
  id: CallId,
  companyId: CompanyId,
  channelId: ChannelId,
  /** Always `huddle_<channelId>` (D1). */
  room: Schema.String,
  startedByKind: MemberKind,
  startedById: MemberId,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.optional(Schema.DateTimeUtc),
  /**
   * The channel message that stands for this huddle (docs/build-plan-huddle-window.md D8):
   * posted when the call opens, edited into the summary when it closes. Its thread is the
   * huddle chat (D9). Absent only when the post itself failed — an archived channel, a
   * starter who is no longer a member — which costs the chat, never the call.
   */
  messageId: Schema.optional(MessageId),
  participants: Schema.optionalWith(Schema.Array(CallParticipant), { default: () => [] })
}) {}

/**
 * What the browser needs to connect: the SFU as the *client* must reach it plus a token scoped
 * to this one room. The token is short-lived (`TAUT_CALL_TOKEN_TTL_SECONDS`, 6h by default);
 * the client refetches by calling `join` again.
 */
export class CallCredentials extends Schema.Class<CallCredentials>('CallCredentials')({
  call: Call,
  /** `wss://…` — `TAUT_LIVEKIT_URL`, never the internal one. */
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.DateTimeUtc
}) {}
