import { SqlClient } from '@effect/sql'
import { Forbidden } from '@taut/contract/errors'
import { AgentId, CompanyId, UserId } from '@taut/contract/ids'
import { Effect, Schema } from 'effect'
import { Count, single } from '../db/sql.js'
import { type Actor, isAdmin } from './access.js'

/**
 * "May this user manage that agent?" — admin+, or the head of a department the agent belongs
 * to (docs/agent-model.md §2). Shared by `Agents` (settings, skills, files) and `Vault`
 * (agent-scoped items) so both answer the same question the same way. Built once per service
 * from the `SqlClient` already in scope; no layer of its own, no cycle between the two.
 */
export interface AgentAccess {
  readonly canManageAgent: (who: Actor, agentId: AgentId) => Effect.Effect<boolean>
  readonly requireManageAgent: (who: Actor, agentId: AgentId) => Effect.Effect<void, Forbidden>
}

export const MANAGE_AGENT_DENIED = "Requires admin or the head of the agent's department"

export const makeAgentAccess: Effect.Effect<AgentAccess, never, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient

    const headOfAgentDepartment = single({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId, userId: UserId }),
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM department_members dm
        JOIN departments d ON d.id = dm.department_id
        WHERE d.company_id = ${r.companyId} AND d.head_user_id = ${r.userId}
          AND dm.member_kind = 'agent' AND dm.member_id = ${r.agentId}`
    })

    const canManageAgent = (who: Actor, agentId: AgentId): Effect.Effect<boolean> =>
      isAdmin(who.role)
        ? Effect.succeed(true)
        : headOfAgentDepartment({ companyId: who.companyId, agentId, userId: who.userId }).pipe(
            Effect.map((c) => c.n > 0)
          )

    const requireManageAgent = (who: Actor, agentId: AgentId): Effect.Effect<void, Forbidden> =>
      canManageAgent(who, agentId).pipe(
        Effect.flatMap((ok) =>
          ok ? Effect.void : Effect.fail(new Forbidden({ message: MANAGE_AGENT_DENIED }))
        )
      )

    return { canManageAgent, requireManageAgent } as const
  }
)

/** One-off form for callers without a service closure: same rule, `SqlClient` from context. */
export const canManageAgent = (
  who: Actor,
  agentId: AgentId
): Effect.Effect<boolean, never, SqlClient.SqlClient> =>
  makeAgentAccess.pipe(Effect.flatMap((a) => a.canManageAgent(who, agentId)))

export const requireManageAgent = (
  who: Actor,
  agentId: AgentId
): Effect.Effect<void, Forbidden, SqlClient.SqlClient> =>
  makeAgentAccess.pipe(Effect.flatMap((a) => a.requireManageAgent(who, agentId)))
