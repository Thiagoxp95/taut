import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import {
  CredentialKind,
  type VaultItemMeta,
  normalizeCredentialSecret
} from '@taut/contract/domain'
import {
  Forbidden,
  NotFound,
  type Unauthorized,
  Validation,
  VaultLocked
} from '@taut/contract/errors'
import {
  AgentId,
  CompanyId,
  SubscriptionId,
  TaskId,
  VaultItemId,
  newVaultItemId
} from '@taut/contract/ids'
import { Effect, Either, Option, Redacted, Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { AppConfig } from '../config.js'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { VaultItemMetaRow, toVaultItemMeta } from '../domain/rows.js'
import { decryptToString, encrypt, hint as hintOf } from '../vault/crypto.js'
import { type Actor, actor, requireAdmin } from './access.js'
import { makeAgentAccess } from './agentAccess.js'
import { AgentHomes } from './homes.js'
import { EventPublisher } from './publisher.js'

const META_COLUMNS =
  'id, company_id, kind, label, hint, created_at, last_used_at, last_used_by, agent_id'

/**
 * How a credential kind reaches the runtime (docs/agent-model.md §4 table). `env` kinds go
 * on the process environment under `envVar`; `file` kinds (`openai.oauth`) are written by the
 * adapter into a per-task `CODEX_HOME/auth.json`; `none` is `generic.secret`.
 */
export const injectionFor = (
  kind: CredentialKind
): { readonly via: 'env'; readonly envVar: string } | { readonly via: 'file' | 'none' } => {
  switch (kind) {
    case 'anthropic.api_key':
      return { via: 'env', envVar: 'ANTHROPIC_API_KEY' }
    case 'claude.oauth':
      return { via: 'env', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' }
    /**
     * The same variable, but the stored value is the whole `claude login`
     * record: the adapter lifts `claudeAiOauth.accessToken` out of it, and
     * `Subscriptions.freshenSeatSecret` rotates that token before spawn so what
     * reaches the runtime is never the expired one.
     */
    case 'claude.login':
      return { via: 'env', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' }
    case 'openai.api_key':
      return { via: 'env', envVar: 'OPENAI_API_KEY' }
    case 'cursor.api_key':
      return { via: 'env', envVar: 'CURSOR_API_KEY' }
    case 'openai.oauth':
      return { via: 'file' }
    case 'generic.secret':
      return { via: 'none' }
  }
}

/** What `resolveForSpawn` hands the scheduler. Unwrap `secret` only at `exec` time. */
export interface ResolvedSecret {
  readonly item: VaultItemMeta
  readonly secret: Redacted.Redacted<string>
  readonly injection: ReturnType<typeof injectionFor>
}

export interface SpawnContext {
  /** The subscription the task runs on (recorded in the audit line). */
  readonly subscriptionId?: SubscriptionId | undefined
  readonly taskId?: TaskId | undefined
}

export interface ToolContext {
  readonly taskId?: TaskId | undefined
}

/**
 * `audit_log.purpose` for a resolve: the scheduler injecting a seat, `vault_get`
 * from a task, or the usage probe reading a seat's quota windows.
 */
export type ResolvePurpose = 'spawn' | 'tool' | 'probe'

/** `list`: absent `agentId` = company items; present = that agent's items (managers only). */
export interface ListVaultInput {
  readonly agentId?: AgentId | undefined
}

export interface AddVaultItemInput {
  readonly kind: CredentialKind
  readonly label: string
  readonly secret: Redacted.Redacted<string>
  /** Present = agent-scoped item. */
  readonly agentId?: AgentId | undefined
}

/**
 * What an agent may create in its own vault. There is deliberately no `agentId` here: the
 * scope is the calling agent, taken from the task token, so the shape itself makes a
 * company-scoped or foreign-scoped write unrepresentable.
 */
export interface AddOwnVaultItemInput {
  readonly kind: CredentialKind
  readonly label: string
  readonly secret: Redacted.Redacted<string>
}

/** What an agent may change about one of its own items: the label, the value, or both. */
export interface UpdateOwnVaultItemInput {
  readonly label?: string | undefined
  readonly secret?: Redacted.Redacted<string> | undefined
}

/**
 * Vault (docs/agent-model.md §3, docs/build-plan-browser-vaults.md). Two scopes in one table:
 * company items (`agent_id IS NULL`, usable by every agent of the company, managed by admin+)
 * and agent items (`agent_id` set, usable only by that agent, managed by admin+ or the head of
 * its department). AES-256-GCM per item, key = HKDF(master, companyId), AAD = item id — the
 * scope is a row-level fact, not a key. Plaintext exists only inside `resolve*`, which are
 * server-internal: no endpoint, event or log ever carries it — `list`/`add` return metadata
 * + `hint` only.
 *
 * Agents write through `addForAgent` / `updateForAgent` / `revokeForAgent` and nothing else.
 * Those three are pinned to the calling agent's own items: a company item or another agent's
 * item is `Forbidden`, and the SQL they run carries `agent_id = <the agent>` in its WHERE
 * clause, so the company vault is structurally unreachable from an agent. `list` / `add` /
 * `revoke` above stay human-only — they take a `CurrentUserShape`, which no agent ever has.
 */
export class Vault extends Effect.Service<Vault>()('Vault', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const config = yield* AppConfig
    const publisher = yield* EventPublisher
    const homes = yield* AgentHomes
    const access = yield* makeAgentAccess
    const masterKey = Redacted.value(config.masterKey)

    // ── queries ──────────────────────────────────────────────────────────────

    const companyItems = findAll({
      Request: CompanyId,
      Result: VaultItemMetaRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(META_COLUMNS)} FROM vault_items
        WHERE company_id = ${companyId} AND agent_id IS NULL ORDER BY created_at ASC, rowid ASC`
    })

    const agentItems = findAll({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId }),
      Result: VaultItemMetaRow,
      execute: (r) => sql`
        SELECT ${sql.literal(META_COLUMNS)} FROM vault_items
        WHERE company_id = ${r.companyId} AND agent_id = ${r.agentId} ORDER BY created_at ASC, rowid ASC`
    })

    /** Company items + one agent's items, in creation order (the agent-runtime `vault_list`). */
    const usableByAgent = findAll({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId }),
      Result: VaultItemMetaRow,
      execute: (r) => sql`
        SELECT ${sql.literal(META_COLUMNS)} FROM vault_items
        WHERE company_id = ${r.companyId} AND (agent_id IS NULL OR agent_id = ${r.agentId})
        ORDER BY created_at ASC, rowid ASC`
    })

    const ItemKey = Schema.Struct({ companyId: CompanyId, vaultItemId: VaultItemId })

    const metaRow = findOne({
      Request: ItemKey,
      Result: VaultItemMetaRow,
      execute: (r) => sql`
        SELECT ${sql.literal(META_COLUMNS)} FROM vault_items
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId}`
    })

    const cipherRow = findOne({
      Request: ItemKey,
      Result: Schema.Struct({ ciphertext: Schema.Uint8ArrayFromSelf }),
      execute: (r) => sql`
        SELECT ciphertext FROM vault_items
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: VaultItemId,
        companyId: CompanyId,
        kind: CredentialKind,
        label: Schema.String,
        ciphertext: Schema.Uint8ArrayFromSelf,
        hint: Schema.String,
        createdAt: Schema.String,
        agentId: Schema.NullOr(AgentId)
      }),
      execute: (r) => sql`
        INSERT INTO vault_items (id, company_id, kind, label, ciphertext, hint, created_at, agent_id)
        VALUES (${r.id}, ${r.companyId}, ${r.kind}, ${r.label}, ${Buffer.from(r.ciphertext)}, ${r.hint}, ${r.createdAt}, ${r.agentId})`
    })

    const remove = run({
      Request: ItemKey,
      execute: (r) =>
        sql`DELETE FROM vault_items WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId}`
    })

    /**
     * The agent-scoped write statements. `agent_id = ${r.agentId}` in the WHERE is not a
     * convenience: it is the enforcement. A company item has `agent_id IS NULL`, which never
     * equals a value, so these three can only ever touch a row the agent owns — even if a
     * caller above them got the authorization wrong.
     */
    const OwnedItemKey = Schema.Struct({ ...ItemKey.fields, agentId: AgentId })

    const updateOwnedLabel = run({
      Request: Schema.Struct({ ...OwnedItemKey.fields, label: Schema.String }),
      execute: (r) => sql`
        UPDATE vault_items SET label = ${r.label}
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId} AND agent_id = ${r.agentId}`
    })

    const updateOwnedSecret = run({
      Request: Schema.Struct({
        ...OwnedItemKey.fields,
        label: Schema.String,
        ciphertext: Schema.Uint8ArrayFromSelf,
        hint: Schema.String
      }),
      execute: (r) => sql`
        UPDATE vault_items SET label = ${r.label}, ciphertext = ${Buffer.from(r.ciphertext)}, hint = ${r.hint}
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId} AND agent_id = ${r.agentId}`
    })

    /**
     * Rewrite a *company* item's ciphertext in place. `agent_id IS NULL` in the
     * WHERE is the same enforcement the owned statements get from `agent_id =`:
     * this can never touch an agent's own secret. Used by the usage probe to
     * rotate a `claude.login` whose access token has expired.
     */
    const rewriteCompanySecret = run({
      Request: Schema.Struct({
        ...ItemKey.fields,
        ciphertext: Schema.Uint8ArrayFromSelf,
        hint: Schema.String
      }),
      execute: (r) => sql`
        UPDATE vault_items SET ciphertext = ${Buffer.from(r.ciphertext)}, hint = ${r.hint}
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId} AND agent_id IS NULL`
    })

    const removeOwned = run({
      Request: OwnedItemKey,
      execute: (r) => sql`
        DELETE FROM vault_items
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId} AND agent_id = ${r.agentId}`
    })

    const touch = run({
      Request: Schema.Struct({ ...ItemKey.fields, agentId: AgentId, at: Schema.String }),
      execute: (r) => sql`
        UPDATE vault_items SET last_used_at = ${r.at}, last_used_by = ${r.agentId}
        WHERE company_id = ${r.companyId} AND id = ${r.vaultItemId}`
    })

    const subscriptionsUsing = findAll({
      Request: ItemKey,
      Result: Schema.Struct({ id: SubscriptionId }),
      execute: (r) => sql`
        SELECT id FROM subscriptions
        WHERE company_id = ${r.companyId} AND credential_id = ${r.vaultItemId} ORDER BY rowid ASC`
    })

    const removeSubscription = run({
      Request: Schema.Struct({ companyId: CompanyId, subscriptionId: SubscriptionId }),
      execute: (r) =>
        sql`DELETE FROM subscriptions WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const insertAudit = run({
      Request: Schema.Struct({
        id: Schema.String,
        companyId: CompanyId,
        agentId: Schema.NullOr(AgentId),
        taskId: Schema.NullOr(TaskId),
        vaultItemId: VaultItemId,
        purpose: Schema.String,
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO audit_log (id, company_id, agent_id, task_id, vault_item_id, purpose, at)
        VALUES (${r.id}, ${r.companyId}, ${r.agentId}, ${r.taskId}, ${r.vaultItemId}, ${r.purpose}, ${r.at})`
    })

    const AgentRef = Schema.Struct({ company_id: CompanyId, handle: Schema.String })

    /** Any company's agent (server-internal callers have no session). */
    const agentRef = findOne({
      Request: AgentId,
      Result: AgentRef,
      execute: (agentId) => sql`SELECT company_id, handle FROM agents WHERE id = ${agentId}`
    })

    /** The agent scoped to the caller's company (a foreign agent reads as `NotFound`). */
    const agentInCompany = findOne({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId }),
      Result: AgentRef,
      execute: (r) =>
        sql`SELECT company_id, handle FROM agents WHERE company_id = ${r.companyId} AND id = ${r.agentId}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const load = (
      companyId: CompanyId,
      vaultItemId: VaultItemId
    ): Effect.Effect<VaultItemMeta, NotFound> =>
      metaRow({ companyId, vaultItemId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'VaultItem', id: vaultItemId })),
            onSome: (row) => Effect.succeed(toVaultItemMeta(row))
          })
        )
      )

    const loadAgent = (
      agentId: AgentId
    ): Effect.Effect<{ readonly company_id: CompanyId; readonly handle: string }, NotFound> =>
      agentRef(agentId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Agent', id: agentId })),
            onSome: Effect.succeed
          })
        )
      )

    /** The agent must be in the caller's company, and the caller must manage it. */
    const requireAgentManager = (
      who: Actor,
      agentId: AgentId
    ): Effect.Effect<void, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const agent = yield* agentInCompany({ companyId: who.companyId, agentId })
        if (Option.isNone(agent)) return yield* new NotFound({ entity: 'Agent', id: agentId })
        yield* access.requireManageAgent(who, agentId)
      })

    /** Who may add / revoke an item of this scope (docs/build-plan-browser-vaults.md table). */
    const requireWriter = (
      who: Actor,
      agentId: AgentId | undefined
    ): Effect.Effect<void, NotFound | Forbidden> =>
      agentId === undefined ? requireAdmin(who) : requireAgentManager(who, agentId)

    const aad = (vaultItemId: VaultItemId): Uint8Array => Buffer.from(vaultItemId, 'utf8')

    // ── endpoints ────────────────────────────────────────────────────────────

    /**
     * Company items (`agentId` absent): any member. Agent items: admin+ or the head of that
     * agent's department; an agent outside the company is `NotFound`. Never both scopes at once.
     */
    const list = (
      me: CurrentUserShape,
      input: ListVaultInput = {}
    ): Effect.Effect<ReadonlyArray<VaultItemMeta>, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        if (input.agentId === undefined) {
          return (yield* companyItems(who.companyId)).map(toVaultItemMeta)
        }
        yield* requireAgentManager(who, input.agentId)
        return (yield* agentItems({ companyId: who.companyId, agentId: input.agentId })).map(
          toVaultItemMeta
        )
      })

    /** Company item: admin+. Agent item (`agentId` set): admin+ or the head of its department. */
    const add = (
      me: CurrentUserShape,
      input: AddVaultItemInput
    ): Effect.Effect<VaultItemMeta, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireWriter(who, input.agentId)
        // One gate for every paste: a half-copied Codex login is rejected here
        // rather than becoming an `auth-failed` seat an hour later.
        const normalized = normalizeCredentialSecret(input.kind, Redacted.value(input.secret))
        if (Either.isLeft(normalized)) {
          return yield* new Validation({ issues: [{ path: ['secret'], message: normalized.left }] })
        }
        const id = newVaultItemId()
        const plaintext = normalized.right
        const ciphertext = encrypt(masterKey, who.companyId, plaintext, { aad: aad(id) })
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* insert({
              id,
              companyId: who.companyId,
              kind: input.kind,
              label: input.label,
              ciphertext,
              hint: hintOf(plaintext),
              createdAt: nowIso(),
              agentId: input.agentId ?? null
            })
            const item = yield* load(who.companyId, id).pipe(Effect.orDie)
            yield* emit({ type: 'vault.item.created', payload: { item } })
            return item
          })
        )
      })

    /**
     * Deletes the item and every subscription that used it (agents pinned to those fall back
     * to rotation via `ON DELETE SET NULL`); writes an audit row. Who may: the same actors
     * that may add an item of that scope (read off the stored row). Running tasks that
     * resolved it are Phase 4's to kill.
     */
    const revoke = (
      me: CurrentUserShape,
      vaultItemId: VaultItemId
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const item = yield* load(who.companyId, vaultItemId)
        yield* requireWriter(who, item.agentId)
        const key = { companyId: who.companyId, vaultItemId }
        yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const subs = yield* subscriptionsUsing(key)
            yield* Effect.forEach(
              subs,
              (s) =>
                removeSubscription({ companyId: who.companyId, subscriptionId: s.id }).pipe(
                  Effect.zipRight(
                    emit({ type: 'subscription.deleted', payload: { subscriptionId: s.id } })
                  )
                ),
              { discard: true }
            )
            yield* insertAudit({
              id: `aud_${randomUUID()}`,
              companyId: who.companyId,
              agentId: null,
              taskId: null,
              vaultItemId,
              purpose: 'revoke',
              at: nowIso()
            })
            yield* remove(key)
            yield* emit({ type: 'vault.item.revoked', payload: { vaultItemId } })
          })
        )
      })

    // ── server-internal ──────────────────────────────────────────────────────

    /**
     * Decrypt `vaultItemId` for `agentId`. A company item (`agentId` null) is usable by every
     * agent of its company; an agent item only by that agent — anything else is `Forbidden`,
     * nothing decrypted. Writes `audit_log(purpose)`, bumps `last_used_*` and appends a line
     * to `<home>/.taut/audit.log`.
     */
    const resolve = (
      vaultItemId: VaultItemId,
      agentId: AgentId,
      purpose: ResolvePurpose,
      context: SpawnContext
    ): Effect.Effect<ResolvedSecret, NotFound | Forbidden | VaultLocked> =>
      Effect.gen(function* () {
        const agent = yield* loadAgent(agentId)
        const companyId = agent.company_id
        const meta = yield* load(companyId, vaultItemId)
        if (meta.agentId !== undefined && meta.agentId !== agentId) {
          return yield* new Forbidden({
            message: `Vault item ${vaultItemId} belongs to another agent`
          })
        }

        const cipher = yield* cipherRow({ companyId, vaultItemId }).pipe(
          Effect.flatMap(Effect.orDie)
        )
        const plaintext = decryptToString(masterKey, companyId, cipher.ciphertext, {
          aad: aad(vaultItemId)
        })
        if (Either.isLeft(plaintext)) {
          return yield* new VaultLocked({
            message: `Cannot decrypt vault item ${vaultItemId}: ${plaintext.left.reason}`
          })
        }

        const at = nowIso()
        yield* sql
          .withTransaction(
            insertAudit({
              id: `aud_${randomUUID()}`,
              companyId,
              agentId,
              taskId: context.taskId ?? null,
              vaultItemId,
              purpose,
              at
            }).pipe(Effect.zipRight(touch({ companyId, vaultItemId, agentId, at })))
          )
          .pipe(Effect.orDie)
        const home = yield* homes.homeOf(companyId, agent.handle)
        yield* homes.appendAudit(
          home,
          `${at} ${purpose} vault=${vaultItemId} task=${context.taskId ?? '-'} subscription=${context.subscriptionId ?? '-'}`
        )

        const item = yield* load(companyId, vaultItemId)
        return {
          item,
          secret: Redacted.make(plaintext.right),
          injection: injectionFor(item.kind)
        }
      })

    /** The scheduler injecting a seat's credential (`audit_log.purpose = "spawn"`). */
    const resolveForSpawn = (
      vaultItemId: VaultItemId,
      agentId: AgentId,
      context: SpawnContext = {}
    ): Effect.Effect<ResolvedSecret, NotFound | Forbidden | VaultLocked> =>
      resolve(vaultItemId, agentId, 'spawn', context)

    /** `vault_get` from a running task (`audit_log.purpose = "tool"`); same rules. */
    const resolveForTool = (
      vaultItemId: VaultItemId,
      agentId: AgentId,
      context: ToolContext = {}
    ): Effect.Effect<ResolvedSecret, NotFound | Forbidden | VaultLocked> =>
      resolve(vaultItemId, agentId, 'tool', { taskId: context.taskId })

    /**
     * Decrypt a *company* item with no agent in the picture, for the usage probe
     * (docs/build-plan-usage-limits.md). It reads a seat's own credential to ask
     * the provider when the seat's window resets, so there is no agent to scope
     * to and nothing to write into an agent's home audit log — the `audit_log`
     * row with `purpose = 'probe'` is the whole trail.
     *
     * An agent-scoped item is refused: a seat's credential is company-wide by
     * definition, and reaching into an agent's own secrets from a background
     * sweep is exactly the thing the vault exists to prevent.
     */
    const resolveForProbe = (
      companyId: CompanyId,
      vaultItemId: VaultItemId
    ): Effect.Effect<ResolvedSecret, NotFound | Forbidden | VaultLocked> =>
      Effect.gen(function* () {
        const meta = yield* load(companyId, vaultItemId)
        if (meta.agentId !== undefined) {
          return yield* new Forbidden({
            message: `Vault item ${vaultItemId} is agent-scoped and cannot back a subscription probe`
          })
        }

        const cipher = yield* cipherRow({ companyId, vaultItemId }).pipe(
          Effect.flatMap(Effect.orDie)
        )
        const plaintext = decryptToString(masterKey, companyId, cipher.ciphertext, {
          aad: aad(vaultItemId)
        })
        if (Either.isLeft(plaintext)) {
          return yield* new VaultLocked({
            message: `Cannot decrypt vault item ${vaultItemId}: ${plaintext.left.reason}`
          })
        }

        yield* insertAudit({
          id: `aud_${randomUUID()}`,
          companyId,
          agentId: null,
          taskId: null,
          vaultItemId,
          purpose: 'probe',
          at: nowIso()
        }).pipe(Effect.orDie)

        return {
          item: meta,
          secret: Redacted.make(plaintext.right),
          injection: injectionFor(meta.kind)
        }
      })

    /**
     * Replace a company item's plaintext with a value the server itself
     * produced — today only a refreshed `claude.login`. There is no endpoint
     * behind this and no operator in the call: a rotation is bookkeeping on a
     * credential the operator already pasted, so it writes no audit row of its
     * own; the `probe` row from the read that triggered it is the trail.
     */
    const rewriteForProbe = (
      companyId: CompanyId,
      vaultItemId: VaultItemId,
      plaintext: string
    ): Effect.Effect<void, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const meta = yield* load(companyId, vaultItemId)
        if (meta.agentId !== undefined) {
          return yield* new Forbidden({
            message: `Vault item ${vaultItemId} is agent-scoped and cannot back a subscription probe`
          })
        }
        yield* rewriteCompanySecret({
          companyId,
          vaultItemId,
          ciphertext: encrypt(masterKey, companyId, plaintext, { aad: aad(vaultItemId) }),
          // The hint the operator recognises the item by stays put. A rotation
          // is the same credential with a newer token inside it, and a hint that
          // changed every few hours would read as a credential someone swapped.
          hint: meta.hint
        }).pipe(Effect.orDie)
      })

    // ── agent self-service (owner hard rule, 2026-09-08) ─────────────────────

    /**
     * An agent may create, change and delete items in **its own vault, and nowhere else**.
     * It can never add to, modify or delete a company item, and never touch another agent's
     * item — those are `Forbidden`, and the SQL underneath carries `agent_id = <the agent>`
     * so no row outside that scope is reachable even by mistake.
     *
     * The `agentId` these take always comes from the task token (`agentApi`), never from a
     * request body, so there is no parameter an agent could bend to widen its own scope.
     * Reading is unchanged: company items stay usable (`listForAgent` / `resolve`), just
     * read-only.
     */
    const auditOwn = (
      companyId: CompanyId,
      agentId: AgentId,
      handle: string,
      vaultItemId: VaultItemId,
      purpose: 'agent_add' | 'agent_update' | 'agent_revoke',
      taskId: TaskId | undefined
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const at = nowIso()
        yield* insertAudit({
          id: `aud_${randomUUID()}`,
          companyId,
          agentId,
          taskId: taskId ?? null,
          vaultItemId,
          purpose,
          at
        }).pipe(Effect.orDie)
        const home = yield* homes.homeOf(companyId, handle)
        yield* homes.appendAudit(
          home,
          `${at} ${purpose} vault=${vaultItemId} task=${taskId ?? '-'}`
        )
      })

    /** Load one item and refuse unless the agent owns it. Company items are refused here. */
    const loadOwned = (
      companyId: CompanyId,
      agentId: AgentId,
      vaultItemId: VaultItemId
    ): Effect.Effect<VaultItemMeta, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const meta = yield* load(companyId, vaultItemId)
        if (meta.agentId === undefined) {
          return yield* new Forbidden({
            message: `Vault item ${vaultItemId} belongs to the company vault, which is read-only for agents`
          })
        }
        if (meta.agentId !== agentId) {
          return yield* new Forbidden({
            message: `Vault item ${vaultItemId} belongs to another agent`
          })
        }
        return meta
      })

    /** Create an item in `agentId`'s own vault. The scope is not an argument — it is the agent. */
    const addForAgent = (
      agentId: AgentId,
      input: AddOwnVaultItemInput,
      context: ToolContext = {}
    ): Effect.Effect<VaultItemMeta, NotFound | Validation> =>
      Effect.gen(function* () {
        const agent = yield* loadAgent(agentId)
        const companyId = agent.company_id
        const normalized = normalizeCredentialSecret(input.kind, Redacted.value(input.secret))
        if (Either.isLeft(normalized)) {
          return yield* new Validation({ issues: [{ path: ['secret'], message: normalized.left }] })
        }
        const id = newVaultItemId()
        const plaintext = normalized.right
        const ciphertext = encrypt(masterKey, companyId, plaintext, { aad: aad(id) })
        const item = yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            yield* insert({
              id,
              companyId,
              kind: input.kind,
              label: input.label,
              ciphertext,
              hint: hintOf(plaintext),
              createdAt: nowIso(),
              agentId
            })
            const created = yield* load(companyId, id).pipe(Effect.orDie)
            yield* emit({ type: 'vault.item.created', payload: { item: created } })
            return created
          })
        )
        yield* auditOwn(companyId, agentId, agent.handle, id, 'agent_add', context.taskId)
        return item
      })

    /** Re-label and/or re-key one of the agent's own items. Nothing else is patchable. */
    const updateForAgent = (
      agentId: AgentId,
      vaultItemId: VaultItemId,
      patch: UpdateOwnVaultItemInput,
      context: ToolContext = {}
    ): Effect.Effect<VaultItemMeta, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const agent = yield* loadAgent(agentId)
        const companyId = agent.company_id
        const current = yield* loadOwned(companyId, agentId, vaultItemId)
        if (patch.label === undefined && patch.secret === undefined) {
          return yield* new Validation({
            issues: [{ path: [], message: 'nothing to update: pass label, secret or both' }]
          })
        }
        const label = patch.label ?? current.label
        const key = { companyId, vaultItemId, agentId }

        if (patch.secret !== undefined) {
          const normalized = normalizeCredentialSecret(current.kind, Redacted.value(patch.secret))
          if (Either.isLeft(normalized)) {
            return yield* new Validation({
              issues: [{ path: ['secret'], message: normalized.left }]
            })
          }
          const plaintext = normalized.right
          const ciphertext = encrypt(masterKey, companyId, plaintext, { aad: aad(vaultItemId) })
          yield* updateOwnedSecret({ ...key, label, ciphertext, hint: hintOf(plaintext) })
        } else {
          yield* updateOwnedLabel({ ...key, label })
        }

        const item = yield* load(companyId, vaultItemId).pipe(Effect.orDie)
        yield* publisher.transact(companyId, (emit) =>
          emit({ type: 'vault.item.updated', payload: { item } })
        )
        yield* auditOwn(
          companyId,
          agentId,
          agent.handle,
          vaultItemId,
          'agent_update',
          context.taskId
        )
        return item
      })

    /**
     * Delete one of the agent's own items. An item that still backs a subscription is refused
     * rather than cascaded: deleting seats is an admin action, and no agent write is allowed
     * to reach past its own vault.
     */
    const revokeForAgent = (
      agentId: AgentId,
      vaultItemId: VaultItemId,
      context: ToolContext = {}
    ): Effect.Effect<void, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const agent = yield* loadAgent(agentId)
        const companyId = agent.company_id
        yield* loadOwned(companyId, agentId, vaultItemId)
        const subs = yield* subscriptionsUsing({ companyId, vaultItemId })
        if (subs.length > 0) {
          return yield* new Forbidden({
            message: `Vault item ${vaultItemId} backs ${subs.length} subscription(s); ask an admin to remove it`
          })
        }
        yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            yield* removeOwned({ companyId, vaultItemId, agentId })
            yield* emit({ type: 'vault.item.revoked', payload: { vaultItemId } })
          })
        )
        yield* auditOwn(
          companyId,
          agentId,
          agent.handle,
          vaultItemId,
          'agent_revoke',
          context.taskId
        )
      })

    /** Metadata of everything `agentId` may resolve: company items + its own (`vault_list`). */
    const listForAgent = (
      agentId: AgentId
    ): Effect.Effect<ReadonlyArray<VaultItemMeta>, NotFound> =>
      loadAgent(agentId).pipe(
        Effect.flatMap((agent) => usableByAgent({ companyId: agent.company_id, agentId })),
        Effect.map((rows) => rows.map(toVaultItemMeta))
      )

    return {
      list,
      add,
      revoke,
      resolveForSpawn,
      resolveForTool,
      resolveForProbe,
      rewriteForProbe,
      listForAgent,
      addForAgent,
      updateForAgent,
      revokeForAgent,
      /** Metadata lookup for other services (subscriptions validate the credential kind). */
      metaById: load
    } as const
  })
}) {}
