/**
 * Keeping installed skills current (docs/build-plan-skills.md D9, D10).
 *
 * Every six hours, for each installed skill that opted into checking and has not been looked at
 * in a day: fetch its `SKILL.md`, hash it, compare. Then the policy decides what that means.
 *
 *   manual  never gets here — the query does not select it
 *   notify  record that upstream moved, and say so once in the agent's DM. The body on disk is
 *           left byte-identical until a human presses Update.
 *   auto    apply it, and say one line about what changed.
 *
 * `notify` is the default on purpose. A skill body is instructions that land in the agent's
 * system prompt, and the person who wrote it upstream is not the person who has to live with
 * what it tells the agent to do. Drifting silently is the one behaviour this must not have.
 *
 * Shaped like `agents/routineRunner.ts`: `Effect.repeat` so ticks never overlap, every skill
 * isolated so one bad repo cannot stop the pass, and `tick(now)` exported so tests drive the
 * clock instead of waiting on it.
 */
import type { CurrentUserShape } from '@taut/contract/api'
import type { Agent, AgentSkill } from '@taut/contract/domain'
import type { AgentId, CompanyId, UserId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Schedule } from 'effect'
import type { AgentSkillRow } from '../domain/rows.js'
import { Agents } from '../services/agents.js'
import { Channels } from '../services/channels.js'
import { Messages } from '../services/messages.js'
import { Users } from '../services/users.js'

/** How often the pass runs. */
export const TICK_INTERVAL = Duration.hours(6)
/** How stale a skill's last look has to be before the pass touches it again. */
export const STALE_AFTER = Duration.hours(24)
/** Skills examined in one tick, so a large instance spreads its checks over several passes. */
export const BATCH = 50
/** Checks in flight at once. GitHub anonymous is 60/hour; this is polite, not fast. */
export const CONCURRENCY = 4

export type CheckOutcome =
  | { readonly _tag: 'unchanged'; readonly name: string }
  | { readonly _tag: 'notified'; readonly name: string }
  | { readonly _tag: 'updated'; readonly name: string }
  /** Looked, and could not tell — the check is recorded so it is not retried immediately. */
  | { readonly _tag: 'failed'; readonly name: string; readonly reason: string }

export class SkillUpdater extends Effect.Service<SkillUpdater>()('SkillUpdater', {
  scoped: Effect.gen(function* () {
    const agents = yield* Agents
    const channels = yield* Channels
    const messages = yield* Messages
    const users = yield* Users

    /**
     * Who hears about it. The person who installed the skill, if they are still in the company;
     * otherwise the head of a department the agent belongs to. Nobody left to tell is not a
     * failure: the badge on the agent page is the other half of this, and it needs no recipient.
     */
    const audience = (
      companyId: CompanyId,
      agent: Agent,
      installedBy: string | null
    ): Effect.Effect<Option.Option<CurrentUserShape>> =>
      Effect.gen(function* () {
        const session = (userId: UserId) =>
          users
            .roleIn(companyId, userId)
            .pipe(
              Effect.map(
                Option.map((role) => ({ userId, activeCompanyId: companyId, role }) as const)
              )
            )

        const installer =
          installedBy?.startsWith('user:') === true
            ? ((installedBy.slice(5) as UserId) ?? undefined)
            : undefined
        if (installer !== undefined) {
          const found = yield* session(installer)
          if (Option.isSome(found)) return found
        }
        const departments = yield* agents.departmentsOf(agent.id)
        for (const department of departments) {
          const found = yield* session(department.headUserId)
          if (Option.isSome(found)) return found
        }
        return Option.none()
      })

    /** One line from the agent, in its DM with whoever is listening. Never fails the tick. */
    const say = (
      companyId: CompanyId,
      agent: Agent,
      installedBy: string | null,
      body: string
    ): Effect.Effect<void> =>
      audience(companyId, agent, installedBy).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (me) =>
              channels.dm(me, { memberKind: 'agent', memberId: agent.id }).pipe(
                Effect.flatMap((channel) =>
                  messages.postAsAgent(companyId, {
                    agentId: agent.id,
                    channelId: channel.id,
                    body
                  })
                )
              )
          })
        ),
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`skills: could not tell anyone about ${agent.handle}`, cause)
        ),
        Effect.asVoid
      )

    /**
     * One skill. The check itself is what stamps `checkedAt`, so even a skill whose repo has
     * gone away stops being retried every pass.
     */
    const checkOne = (agent: Agent, skill: AgentSkillRow): Effect.Effect<CheckOutcome> =>
      Effect.gen(function* () {
        const detail = yield* agents.checkSkillInternal(agent.companyId, agent.id, skill.name)
        if (!detail.updateAvailable) return { _tag: 'unchanged', name: skill.name } as const

        const where = detail.source ?? 'its source'
        if (skill.update_policy === 'auto') {
          const applied: AgentSkill = yield* agents.applySkillUpdateInternal(
            agent.companyId,
            agent.id,
            skill.name
          )
          yield* say(
            agent.companyId,
            agent,
            skill.installed_by,
            `Updated my \`${applied.name}\` skill from ${where}. It changed upstream and its update policy is set to auto.`
          )
          return { _tag: 'updated', name: skill.name } as const
        }

        yield* say(
          agent.companyId,
          agent,
          skill.installed_by,
          `My \`${skill.name}\` skill changed at ${where}. I have not touched the copy I am using. Open my skills to see the difference and decide.`
        )
        return { _tag: 'notified', name: skill.name } as const
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(`skills: check failed for ${agent.handle}/${skill.name}`).pipe(
            Effect.as({
              _tag: 'failed' as const,
              name: skill.name,
              reason: 'message' in error ? error.message : String(error)
            })
          )
        ),
        Effect.catchAllDefect((defect) =>
          Effect.logWarning(`skills: check blew up for ${agent.handle}/${skill.name}`, defect).pipe(
            Effect.as({ _tag: 'failed' as const, name: skill.name, reason: 'internal error' })
          )
        )
      )

    /** One pass. Exposed so tests supply the clock instead of waiting six hours for it. */
    const tick = (now: DateTime.Utc): Effect.Effect<ReadonlyArray<CheckOutcome>> =>
      Effect.gen(function* () {
        const staleBefore = DateTime.toDate(
          DateTime.subtract(now, { millis: Duration.toMillis(STALE_AFTER) })
        ).toISOString()
        const due = yield* agents.skillsDueForCheck(staleBefore, BATCH)
        if (due.length === 0) return []
        return yield* Effect.forEach(due, ({ agent, skill }) => checkOne(agent, skill), {
          concurrency: CONCURRENCY
        })
      })

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const now = yield* DateTime.now
        return yield* tick(now)
      }).pipe(
        Effect.catchAllCause((cause) => Effect.logWarning('skills: tick failed', cause)),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL))
      )
    )

    return { tick } as const
  })
}) {}

/** Re-exported for the tests, which assert on the agent id rather than the whole row. */
export type { AgentId }
