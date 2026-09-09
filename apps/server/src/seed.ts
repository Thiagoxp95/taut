/**
 * Demo data through the real services (never raw SQL). Idempotent: re-running finds
 * what already exists and only fills the gaps.
 *
 *   pnpm --filter @taut/server seed
 *
 * Creates: owner@taut.local / password123 (owner), dana@taut.local / password123 (member),
 * company "Acme" (acme), departments Engineering (head owner) + Design (head dana), channels
 * #engineering, #design, #backend, a DM between the two, 20 sample messages, one vault item
 * (`anthropic.api_key`, fake), one `claude-code` subscription on it, and agents `bruno`
 * (Engineering, skill `review-pr`), `mila` (Design) and `ops` (no department).
 */
import { NodeRuntime } from '@effect/platform-node'
import type { CurrentUserShape } from '@taut/contract/api'
import type { Company, MembershipRole, User } from '@taut/contract/domain'
import { Effect, Option, Redacted } from 'effect'
import { ServicesLive } from './layers.js'
import { Agents } from './services/agents.js'
import { Auth } from './services/auth.js'
import { Channels } from './services/channels.js'
import { Companies } from './services/companies.js'
import { Departments } from './services/departments.js'
import { Messages } from './services/messages.js'
import { EventPublisher } from './services/publisher.js'
import { Subscriptions } from './services/subscriptions.js'
import { Users } from './services/users.js'
import { Vault } from './services/vault.js'

export const SEED_PASSWORD = 'password123'

const SAMPLE_MESSAGES: ReadonlyArray<string> = [
  'Morning! Kicking off the week — anything blocking?',
  'Nothing on my side. Finishing the onboarding flow today.',
  'Nice. Can you also look at the flaky ws test when you get a moment?',
  "Sure, I'll take it after lunch.",
  '@dana the invite email copy is in the doc, feel free to edit.',
  'Got it, thanks @owner.',
  'Deploying the migration to staging now.',
  'Migration went fine, 0002 applied.',
  'Anyone against moving standup to 10:00?',
  'Fine by me.',
  'Reminder: vault rotation is a Phase 3 task, not this week.',
  'Ack.',
  'The seq-based resume works end to end — reconnects replay cleanly.',
  'That was the scary one, glad it is done.',
  'Design review at 15:00 in #design.',
  'I will bring the new sidebar mocks.',
  'Coffee?',
  'Always.',
  'Closing the loop: unread badges now come from last_read_seq.',
  'Ship it.'
]

const program = Effect.gen(function* () {
  const auth = yield* Auth
  const users = yield* Users
  const companies = yield* Companies
  const departments = yield* Departments
  const channels = yield* Channels
  const messages = yield* Messages
  const publisher = yield* EventPublisher
  const vault = yield* Vault
  const subscriptions = yield* Subscriptions
  const agents = yield* Agents

  const ensureUser = (email: string, name: string): Effect.Effect<User> =>
    users.byEmailWithHash(email).pipe(
      Effect.flatMap(
        Option.match({
          onSome: (row) => users.byId(row.id).pipe(Effect.flatMap(Effect.orDie)),
          onNone: () =>
            auth.signup({ email, password: SEED_PASSWORD, name }).pipe(
              Effect.map((a) => a.user),
              Effect.orDie
            )
        })
      )
    )

  const owner = yield* ensureUser('owner@taut.local', 'Owner')
  const dana = yield* ensureUser('dana@taut.local', 'Dana')

  const ownerBare: CurrentUserShape = { userId: owner.id }
  const existing = yield* companies.list(ownerBare)
  const acme: Company = yield* Option.match(
    Option.fromNullable(existing.find((c) => c.company.slug === 'acme')),
    {
      onSome: (c) => Effect.succeed(c.company),
      onNone: () =>
        companies
          .create(
            ownerBare,
            { slug: 'acme', name: 'Acme', avatar: { kind: 'emoji', value: '🏢' } },
            undefined
          )
          .pipe(Effect.orDie)
    }
  )

  const as = (user: User, role: MembershipRole): CurrentUserShape => ({
    userId: user.id,
    activeCompanyId: acme.id,
    role
  })
  const meOwner = as(owner, 'owner')
  const meDana = as(dana, 'member')

  if (Option.isNone(yield* users.roleIn(acme.id, dana.id))) {
    yield* publisher.transact(acme.id, (emit) => companies.join(acme.id, dana, 'member', emit))
  }

  const ensureDepartment = (name: string, slug: string, head: User) =>
    departments.list(meOwner).pipe(
      Effect.flatMap((all) =>
        Option.match(Option.fromNullable(all.find((d) => d.slug === slug)), {
          onSome: Effect.succeed,
          onNone: () =>
            departments.create(meOwner, { name, slug, headUserId: head.id }).pipe(Effect.orDie)
        })
      )
    )
  const engineering = yield* ensureDepartment('Engineering', 'engineering', owner)
  const design = yield* ensureDepartment('Design', 'design', dana)

  const engineeringDetail = yield* departments.get(meOwner, engineering.id).pipe(Effect.orDie)
  if (!engineeringDetail.members.some((m) => m.memberId === dana.id)) {
    yield* departments
      .addMember(meOwner, engineering.id, { memberKind: 'user', memberId: dana.id })
      .pipe(Effect.orDie)
  }
  const designDetail = yield* departments.get(meOwner, design.id).pipe(Effect.orDie)
  if (!designDetail.members.some((m) => m.memberId === owner.id)) {
    yield* departments
      .addMember(meOwner, design.id, { memberKind: 'user', memberId: owner.id })
      .pipe(Effect.orDie)
  }

  const all = yield* channels.list(meOwner, {})
  const ensureChannel = (name: string, departmentId: typeof engineering.id) =>
    Option.match(
      Option.fromNullable(all.find((c) => c.name === name && c.departmentId === departmentId)),
      {
        onSome: Effect.succeed,
        onNone: () =>
          channels
            .create(meOwner, {
              name,
              departmentId,
              members: [{ memberKind: 'user', memberId: dana.id }]
            })
            .pipe(Effect.orDie)
      }
    )
  const general = yield* ensureChannel('engineering', engineering.id)
  yield* ensureChannel('backend', engineering.id)
  yield* channels.dm(meOwner, { memberKind: 'user', memberId: dana.id }).pipe(Effect.orDie)

  const page = yield* messages.list(meOwner, { channelId: general.id, limit: 1 }).pipe(Effect.orDie)
  let posted = 0
  if (page.items.length === 0) {
    for (const [i, body] of SAMPLE_MESSAGES.entries()) {
      yield* messages
        .create(i % 2 === 0 ? meOwner : meDana, { channelId: general.id, body })
        .pipe(Effect.orDie)
      posted++
    }
  }

  // ── Phase 3: vault → subscription → agents ────────────────────────────────

  const vaultItems = yield* vault.list(meOwner)
  const anthropicKey = yield* Option.match(
    Option.fromNullable(vaultItems.find((v) => v.label === 'Acme Anthropic key')),
    {
      onSome: Effect.succeed,
      onNone: () =>
        vault
          .add(meOwner, {
            kind: 'anthropic.api_key',
            label: 'Acme Anthropic key',
            secret: Redacted.make('sk-ant-api03-demo-not-a-real-key-0000000000000000demo')
          })
          .pipe(Effect.orDie)
    }
  )

  const subs = yield* subscriptions.list(meOwner)
  const claudeSeat = yield* Option.match(
    Option.fromNullable(subs.find((s) => s.label === 'Claude Code — Acme')),
    {
      onSome: Effect.succeed,
      onNone: () =>
        subscriptions
          .add(meOwner, {
            runtime: 'claude-code',
            label: 'Claude Code — Acme',
            credentialId: anthropicKey.id
          })
          .pipe(Effect.orDie)
    }
  )

  const existingAgents = yield* agents.list(meOwner)
  const ensureAgent = (input: {
    readonly handle: string
    readonly name: string
    readonly emoji: string
    readonly role: string
    readonly mandate: string
    readonly departmentId?: typeof engineering.id | undefined
  }) =>
    Option.match(Option.fromNullable(existingAgents.find((a) => a.handle === input.handle)), {
      onSome: Effect.succeed,
      onNone: () =>
        agents
          .create(meOwner, {
            handle: input.handle,
            name: input.name,
            avatar: { kind: 'emoji', value: input.emoji },
            role: input.role,
            mandate: input.mandate,
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: input.departmentId
          })
          .pipe(Effect.orDie)
    })

  const bruno = yield* ensureAgent({
    handle: 'bruno',
    name: 'Bruno',
    emoji: '🦫',
    role: 'Backend engineer',
    mandate: [
      '# Mandate',
      '',
      'You are the backend engineer of Acme Engineering. Review pull requests, fix bugs and',
      'keep the API contract honest. Never push to `main` directly; never touch billing code',
      'without the department head signing off. Report in the thread you were mentioned in.'
    ].join('\n'),
    departmentId: engineering.id
  })
  yield* ensureAgent({
    handle: 'mila',
    name: 'Mila',
    emoji: '🎨',
    role: 'Designer',
    mandate:
      '# Mandate\n\nYou design Acme product surfaces. Propose, critique and iterate on UI; keep the design tokens in `@taut/ui` the single source of truth.',
    departmentId: design.id
  })
  yield* ensureAgent({
    handle: 'ops',
    name: 'Ops',
    emoji: '🛠️',
    role: 'Operations',
    mandate:
      '# Mandate\n\nCompany-wide operations: deployments, backups, incident notes. You report to the owner.'
  })

  const brunoDetail = yield* agents.get(meOwner, bruno.id).pipe(Effect.orDie)
  if (!brunoDetail.skills.some((s) => s.name === 'review-pr')) {
    yield* agents
      .putSkill(meOwner, bruno.id, 'review-pr', {
        description: 'Review a pull request for correctness, tests and contract drift.',
        body: [
          '# Review a PR',
          '',
          '1. Read the diff end to end before commenting.',
          '2. Check that every changed endpoint still matches `packages/contract`.',
          '3. Run `pnpm typecheck && pnpm test`; quote failures verbatim.',
          '4. Summarise: blocking issues first, then nits. Be brief.'
        ].join('\n')
      })
      .pipe(Effect.orDie)
  }

  yield* Effect.logInfo(
    `seed: company ${acme.slug} (${acme.id}) · users owner@taut.local, dana@taut.local (password "${SEED_PASSWORD}") · departments engineering, design · ${posted} messages posted · vault ${anthropicKey.id} · subscription ${claudeSeat.id} (${claudeSeat.status}) · agents bruno, mila, ops`
  )
})

NodeRuntime.runMain(program.pipe(Effect.provide(ServicesLive)))
