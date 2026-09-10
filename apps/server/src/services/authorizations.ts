import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import type { AuthorizationRequest, Message } from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound, Validation } from '@taut/contract/errors'
import type { AgentId, CompanyId, MessageId, UserId } from '@taut/contract/ids'
import { Effect, Option } from 'effect'
import type { TokenPrincipal } from '../agents/tokens.js'
import { nowIso } from '../db/sql.js'
import { actor } from './access.js'
import { Agents } from './agents.js'
import { Channels } from './channels.js'
import { Messages } from './messages.js'
import { EventPublisher } from './publisher.js'
import { Tasks } from './tasks.js'

const denied = () =>
  new Forbidden({
    message: 'A human member of the agent’s department must request and authorize this change.'
  })

/** Human decisions live here, outside the agent tool API. Proposal content never comes from a decision payload. */
export class Authorizations extends Effect.Service<Authorizations>()('Authorizations', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const agents = yield* Agents
    const messages = yield* Messages
    const channels = yield* Channels
    const tasks = yield* Tasks
    const publisher = yield* EventPublisher

    const sharesDepartment = (companyId: CompanyId, agentId: AgentId, userId: UserId) =>
      sql`SELECT 1 FROM department_members a
        JOIN departments d ON d.id = a.department_id
        JOIN department_members u ON u.department_id = a.department_id
        JOIN memberships m ON m.company_id = d.company_id AND m.user_id = u.member_id
        WHERE d.company_id = ${companyId} AND a.member_kind = 'agent' AND a.member_id = ${agentId}
          AND u.member_kind = 'user' AND u.member_id = ${userId} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie
      )

    const load = (me: CurrentUserShape, messageId: MessageId) =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const found = yield* messages.byId(who.companyId, messageId)
        if (Option.isNone(found) || found.value.authorization === undefined)
          return yield* new NotFound({ entity: 'Authorization', id: messageId })
        const message = found.value
        yield* channels.get(me, message.channelId)
        return { who, message, request: found.value.authorization }
      })

    const canDecide = (companyId: CompanyId, request: AuthorizationRequest, userId: UserId) =>
      Effect.gen(function* () {
        const requester = yield* sharesDepartment(companyId, request.agentId, request.requestedBy)
        return requester && (yield* sharesDepartment(companyId, request.agentId, userId))
      })

    return {
      proposeMandate: (principal: TokenPrincipal, mandate: string) =>
        Effect.gen(function* () {
          if (mandate.trim().length === 0 || mandate.length > 100_000)
            return yield* new Validation({
              issues: [
                { path: ['mandate'], message: 'Use a nonempty mandate up to 100,000 characters.' }
              ]
            })
          const internal = yield* tasks.internal(principal.companyId, principal.taskId)
          const task = internal.task
          if (
            task.agentId !== principal.agentId ||
            internal.triggerUserId === undefined ||
            internal.triggerMessageId === undefined ||
            internal.parentTaskId !== undefined ||
            task.routineId !== undefined ||
            task.signalId !== undefined
          )
            return yield* denied()
          const trigger = yield* messages.byId(principal.companyId, internal.triggerMessageId)
          if (
            Option.isNone(trigger) ||
            trigger.value.authorKind !== 'user' ||
            trigger.value.authorId !== internal.triggerUserId ||
            trigger.value.channelId !== task.channelId
          )
            return yield* denied()
          if (
            !(yield* sharesDepartment(
              principal.companyId,
              principal.agentId,
              internal.triggerUserId
            ))
          )
            return yield* denied()
          const agent = yield* agents.byId(principal.companyId, principal.agentId)
          if (agent.archivedAt !== undefined) return yield* denied()
          const authorization: AuthorizationRequest = {
            kind: 'mandate.update',
            agentId: agent.id,
            requestedBy: internal.triggerUserId,
            requestMessageId: internal.triggerMessageId,
            previousMandate: agent.mandate,
            proposedMandate: mandate,
            status: 'pending'
          }
          return yield* messages.postAsAgent(principal.companyId, {
            agentId: agent.id,
            channelId: task.channelId,
            threadId: internal.repliesInThread ? task.threadId : undefined,
            body: 'Please review my proposed mandate.',
            authorization
          })
        }),
      inspect: (me: CurrentUserShape, messageId: MessageId) =>
        Effect.gen(function* () {
          const { who, request } = yield* load(me, messageId)
          return {
            canDecide:
              request.status === 'pending' && (yield* canDecide(who.companyId, request, who.userId))
          }
        }),
      decide: (me: CurrentUserShape, messageId: MessageId, decision: 'approve' | 'decline') =>
        Effect.gen(function* () {
          const who = yield* actor(me)
          return yield* publisher.transact(who.companyId, (emit) =>
            Effect.gen(function* () {
              const { request, message } = yield* load(me, messageId)
              if (!(yield* canDecide(who.companyId, request, who.userId))) return yield* denied()
              if (request.status !== 'pending')
                return yield* new Conflict({ reason: 'This request has already been decided.' })
              let status: AuthorizationRequest['status'] = 'declined'
              if (decision === 'approve') {
                const applied = yield* agents.applyApprovedMandate(
                  emit,
                  who.companyId,
                  request.agentId,
                  request.previousMandate,
                  request.proposedMandate
                )
                status = applied ? 'approved' : 'superseded'
              }
              const updated: Message = yield* messages.setAuthorization(
                emit,
                who.companyId,
                message.id,
                {
                  ...request,
                  status,
                  decidedBy: who.userId,
                  decidedAt: nowIso()
                }
              )
              return updated
            })
          )
        })
    } as const
  })
}) {}
