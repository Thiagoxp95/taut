import { Schema } from 'effect'

import { ChannelId, CompanyId, DepartmentId, EventSeq, MemberId } from '../ids.js'
import { ChannelKind, MemberKind } from './enums.js'
import { DisplayName } from './primitives.js'

export class Channel extends Schema.Class<Channel>('Channel')({
  id: ChannelId,
  companyId: CompanyId,
  /** Absent for DMs. */
  departmentId: Schema.optional(DepartmentId),
  name: DisplayName,
  kind: ChannelKind,
  /**
   * When the channel was archived. History stays readable, nothing new can be posted, and
   * the sidebar files it away. A DM is archived with the agent on the other side of it.
   */
  archivedAt: Schema.optional(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc
}) {}

export class ChannelMember extends Schema.Class<ChannelMember>('ChannelMember')({
  channelId: ChannelId,
  memberKind: MemberKind,
  memberId: MemberId,
  lastReadSeq: EventSeq
}) {}
