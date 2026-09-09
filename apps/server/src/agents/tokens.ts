import { SqlClient } from '@effect/sql'
import { AgentId, CompanyId, TaskId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { createHash, randomBytes } from 'node:crypto'
import { findOne, nowIso, run } from '../db/sql.js'

/** Who a valid `TAUT_TOKEN` stands for. The sender is never an argument (agent-model §9). */
export interface TokenPrincipal {
  readonly taskId: TaskId
  readonly agentId: AgentId
  readonly companyId: CompanyId
}

/** Tokens stay valid this long after the task ends (late `taut_done`, final memory notes). */
export const TOKEN_GRACE_MS = 10 * 60 * 1000

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * Task-scoped bearer tokens for `/api/agent-runtime/*`. 32 random bytes (hex on the wire),
 * only the sha-256 stored. `expires_at` is NULL while the task runs and `ended + 10 min` after.
 */
export class TaskTokens extends Effect.Service<TaskTokens>()('TaskTokens', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const insert = run({
      Request: Schema.Struct({
        tokenHash: Schema.String,
        taskId: TaskId,
        agentId: AgentId,
        companyId: CompanyId,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO task_tokens (token_hash, task_id, agent_id, company_id, created_at, expires_at)
        VALUES (${r.tokenHash}, ${r.taskId}, ${r.agentId}, ${r.companyId}, ${r.createdAt}, NULL)`
    })

    const lookup = findOne({
      Request: Schema.String,
      Result: Schema.Struct({
        task_id: TaskId,
        agent_id: AgentId,
        company_id: CompanyId,
        expires_at: Schema.NullOr(Schema.String)
      }),
      execute: (tokenHash) => sql`
        SELECT task_id, agent_id, company_id, expires_at FROM task_tokens WHERE token_hash = ${tokenHash}`
    })

    const expire = run({
      Request: Schema.Struct({ taskId: TaskId, expiresAt: Schema.String }),
      execute: (r) => sql`
        UPDATE task_tokens SET expires_at = ${r.expiresAt}
        WHERE task_id = ${r.taskId} AND expires_at IS NULL`
    })

    /** Mint a fresh token for a task. Returns the plaintext once; it is never stored. */
    const mint = (principal: TokenPrincipal): Effect.Effect<string> =>
      Effect.gen(function* () {
        const token = randomBytes(32).toString('hex')
        yield* insert({ tokenHash: hash(token), ...principal, createdAt: nowIso() })
        return token
      })

    const verify = (token: string): Effect.Effect<Option.Option<TokenPrincipal>> =>
      lookup(hash(token)).pipe(
        Effect.map(
          Option.flatMap((row) =>
            row.expires_at !== null && row.expires_at <= nowIso()
              ? Option.none()
              : Option.some({
                  taskId: row.task_id,
                  agentId: row.agent_id,
                  companyId: row.company_id
                })
          )
        )
      )

    /** Called when a task ends: every token of the task expires `TOKEN_GRACE_MS` from now. */
    const expireForTask = (taskId: TaskId): Effect.Effect<void> =>
      expire({ taskId, expiresAt: new Date(Date.now() + TOKEN_GRACE_MS).toISOString() })

    return { mint, verify, expireForTask } as const
  })
}) {}
