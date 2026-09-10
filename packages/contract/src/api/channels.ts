import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Canvas, CanvasDocument } from '../domain/canvas.js'
import { Channel, ChannelMember } from '../domain/channel.js'
import { ThreadContext } from '../domain/context.js'
import { MemberKind } from '../domain/enums.js'
import { DisplayName } from '../domain/primitives.js'
import { Conflict, Forbidden, NotFound, Validation } from '../errors.js'
import { ChannelId, DepartmentId, EventSeq, MemberId, MessageId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const ListChannelsQuery = Schema.Struct({
  ...PageQuery.fields,
  departmentId: Schema.optional(DepartmentId)
})

export const CreateChannelPayload = Schema.Struct({
  name: DisplayName,
  /**
   * Required on `create` (channels belong to a department; DMs go through `dm`): the server
   * answers 422 `Validation` when it is missing. Optional in the schema only so existing
   * clients keep compiling; it becomes `DepartmentId` once `@taut/web` drops the `?`.
   */
  departmentId: Schema.optional(DepartmentId),
  /** Initial members besides the creator. */
  members: Schema.optional(
    Schema.Array(Schema.Struct({ memberKind: MemberKind, memberId: MemberId }))
  )
})

export const UpdateChannelPayload = Schema.partial(Schema.Struct({ name: DisplayName }))

export const ChannelMemberPayload = Schema.Struct({ memberKind: MemberKind, memberId: MemberId })

/** Open (or return the existing) DM between the current user and a user or agent. */
export const OpenDmPayload = Schema.Struct({ memberKind: MemberKind, memberId: MemberId })

export const MarkReadPayload = Schema.Struct({ lastReadSeq: EventSeq })

/** Latest received message per DM, including replies; reading the inbox does not mark it read. */
export const DmInboxItem = Schema.Struct({
  channelId: ChannelId,
  messageId: MessageId,
  threadId: Schema.NullOr(MessageId),
  authorId: MemberId,
  authorKind: MemberKind,
  body: Schema.String,
  createdAt: Schema.DateTimeUtc,
  /** Read watermark across received messages; a streamed reply can finish after a later seq. */
  seq: EventSeq,
  unread: Schema.Number,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc)
})
export type DmInboxItem = typeof DmInboxItem.Type

const ChannelPath = Schema.Struct({ channelId: ChannelId })
const ChannelMemberPath = Schema.Struct({
  channelId: ChannelId,
  memberKind: MemberKind,
  memberId: MemberId
})

export class ChannelsGroup extends HttpApiGroup.make('channels')
  .add(HttpApiEndpoint.get('list', '/').setUrlParams(ListChannelsQuery).addSuccess(Page(Channel)))
  .add(HttpApiEndpoint.get('inbox', '/inbox').addSuccess(Page(DmInboxItem)))
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateChannelPayload)
      .addSuccess(Channel, { status: 201 })
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Conflict)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.post('dm', '/dm')
      .setPayload(OpenDmPayload)
      .addSuccess(Channel)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.get('get', '/:channelId')
      .setPath(ChannelPath)
      .addSuccess(Channel)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.patch('update', '/:channelId')
      .setPath(ChannelPath)
      .setPayload(UpdateChannelPayload)
      .addSuccess(Channel)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.del('delete', '/:channelId')
      .setPath(ChannelPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.get('members', '/:channelId/members')
      .setPath(ChannelPath)
      .setUrlParams(PageQuery)
      .addSuccess(Page(ChannelMember))
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('addMember', '/:channelId/members')
      .setPath(ChannelPath)
      .setPayload(ChannelMemberPayload)
      .addSuccess(ChannelMember, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .add(
    HttpApiEndpoint.del('removeMember', '/:channelId/members/:memberKind/:memberId')
      .setPath(ChannelMemberPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /**
     * Every open context window in the channel (docs/build-plan-context-meter.md).
     * The client seeds its rings from this on boot and then keeps them from
     * `agent.context.updated`, so a refresh mid-run does not blank the meters —
     * the same arrangement the shimmer set uses.
     */
    HttpApiEndpoint.get('context', '/:channelId/context')
      .setPath(ChannelPath)
      .addSuccess(Schema.Array(ThreadContext))
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('markRead', '/:channelId/read')
      .setPath(ChannelPath)
      .setPayload(MarkReadPayload)
      .addSuccess(ChannelMember)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.get('canvases', '/:channelId/canvases')
      .setPath(ChannelPath)
      .addSuccess(Schema.Array(Canvas))
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.get('canvas', '/:channelId/canvases/:canvasId')
      .setPath(Schema.Struct({ channelId: ChannelId, canvasId: Schema.String }))
      .addSuccess(CanvasDocument)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/channels') {}
