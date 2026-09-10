import { Schema } from 'effect'
import { AgentId, MessageId, UserId } from '../ids.js'

export const AuthorizationStatus = Schema.Literal('pending', 'approved', 'declined', 'superseded')
export type AuthorizationStatus = typeof AuthorizationStatus.Type

/** Immutable proposal and its human decision. Add future action shapes as a discriminated union. */
export const AuthorizationRequest = Schema.Struct({
  kind: Schema.Literal('mandate.update'),
  agentId: AgentId,
  requestedBy: UserId,
  requestMessageId: MessageId,
  previousMandate: Schema.String,
  proposedMandate: Schema.String,
  status: AuthorizationStatus,
  decidedBy: Schema.optional(UserId),
  decidedAt: Schema.optional(Schema.String)
})
export type AuthorizationRequest = typeof AuthorizationRequest.Type
