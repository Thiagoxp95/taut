import { Schema } from 'effect'

import { ChannelId, CompanyId, DepartmentId, EventSeq, MemberId, ProjectId } from '../ids.js'
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
  /**
   * Hidden channels back an issue's threads (docs/build-plan-issues.md D9): real
   * in every way — search, mentions, notifications, unread, tasks — but absent
   * from the sidebar, because their home is the ticket page and a second row to
   * click would be a second place the same conversation appears.
   *
   * Defaulted rather than required: every channel that existed before D9 is a
   * visible one, and must still decode.
   */
  hidden: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /**
   * The project whose tickets talk here, when this is one of those channels (D9).
   * One per project, created lazily with the first thread in it — which is why
   * this is absent on every ordinary channel and on most projects.
   */
  projectId: Schema.optional(ProjectId),
  createdAt: Schema.DateTimeUtc
}) {}

export class ChannelMember extends Schema.Class<ChannelMember>('ChannelMember')({
  channelId: ChannelId,
  memberKind: MemberKind,
  memberId: MemberId,
  lastReadSeq: EventSeq
}) {}
