import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Company, Department, Subscription, VaultItemMeta } from '@taut/contract/domain'
import { Effect, Either, Redacted, Schema } from 'effect'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import { AppConfig } from '../src/config.js'
import { Agents } from '../src/services/agents.js'
import { agentHomePath } from '../src/services/homes.js'
import { Subscriptions } from '../src/services/subscriptions.js'
import { Tasks } from '../src/services/tasks.js'
import { Vault } from '../src/services/vault.js'
import { decryptToString } from '../src/vault/crypto.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { TEST_MASTER_KEY_BYTES, makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
const outside = mkdtempSync(join(tmpdir(), 'taut-outside-'))
afterAll(() => {
  removeDir(dir)
  removeDir(outside)
})

const avatar = { kind: 'emoji', value: 'A' } as const
const SECRET = 'sk-ant-api03-test-secret-value-9f3a'

const state: {
  owner?: TestClient
  dana?: TestClient
  bob?: TestClient
  acme?: Company
  engineering?: Department
  design?: Department
  item?: VaultItemMeta
  seat?: Subscription
  seats?: ReadonlyArray<Subscription>
  bruno?: Agent
  mila?: Agent
  home?: string
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const CipherRows = Schema.Array(Schema.Struct({ ciphertext: Schema.Uint8ArrayFromSelf }))
const CountRows = Schema.Array(Schema.Struct({ n: Schema.Number }))
const TypeRows = Schema.Array(Schema.Struct({ type: Schema.String }))
const TasksTodayRows = Schema.Array(
  Schema.Struct({ tasks_today: Schema.Number, tasks_today_date: Schema.NullOr(Schema.String) })
)

describe('phase 3 (vault → subscriptions → agents → tasks)', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('setup: owner, member dana (head of design), outsider bob, two departments', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()

        const invite = (email: string) =>
          owner.api.invites.create({ payload: { email, role: 'member' } })
        const danaInvite = yield* invite('dana@taut.local')
        const dana = yield* makeClient
        const danaAccepted = yield* dana.api.invites.accept({
          payload: { token: danaInvite.token, name: 'Dana', password: 'password123' }
        })
        const bobInvite = yield* invite('bob@taut.local')
        const bob = yield* makeClient
        yield* bob.api.invites.accept({
          payload: { token: bobInvite.token, name: 'Bob', password: 'password123' }
        })

        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const design = yield* owner.api.departments.create({
          payload: { name: 'Design', slug: 'design', headUserId: danaAccepted.user.id }
        })
        yield* owner.api.departments.addMember({
          path: { departmentId: engineering.id },
          payload: { memberKind: 'user', memberId: danaAccepted.user.id }
        })

        Object.assign(state, { owner, dana, bob, acme, engineering, design })
      })
    )

    // ── vault ────────────────────────────────────────────────────────────────

    it.effect(
      'vault.add is admin+, returns metadata + hint only; ciphertext is bound to the item id',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const acme = need(state.acme, 'acme')

          const denied = yield* Effect.flip(
            dana.api.vault.add({
              payload: { kind: 'anthropic.api_key', label: 'nope', secret: Redacted.make(SECRET) }
            })
          )
          expect(denied._tag).toBe('Forbidden')

          const item = yield* owner.api.vault.add({
            payload: {
              kind: 'anthropic.api_key',
              label: 'Acme Anthropic key',
              secret: Redacted.make(SECRET)
            }
          })
          expect(item.hint).toBe(SECRET.slice(-4))
          expect(item.kind).toBe('anthropic.api_key')
          const wire = JSON.stringify(item)
          expect(wire).not.toContain(SECRET)
          expect(Object.keys(item)).not.toContain('ciphertext')
          expect(Object.keys(item)).not.toContain('secret')

          // Members can list metadata.
          const listed = yield* dana.api.vault.list({ urlParams: {} })
          expect(listed.items.map((i) => i.id)).toEqual([item.id])
          expect(JSON.stringify(listed)).not.toContain(SECRET)

          // What is on disk decrypts with (master key, companyId, AAD = item id) and nothing else.
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql`SELECT ciphertext FROM vault_items WHERE id = ${item.id}`.pipe(
            Effect.flatMap(Schema.decodeUnknown(CipherRows))
          )
          const ciphertext = need(rows[0], 'cipher row').ciphertext
          expect(Buffer.from(ciphertext).toString('utf8')).not.toContain(SECRET)
          const ok = decryptToString(TEST_MASTER_KEY_BYTES, acme.id, ciphertext, {
            aad: Buffer.from(item.id)
          })
          expect(Either.getOrThrow(ok)).toBe(SECRET)
          const wrongAad = decryptToString(TEST_MASTER_KEY_BYTES, acme.id, ciphertext, {
            aad: Buffer.from('vlt_other')
          })
          expect(Either.isLeft(wrongAad)).toBe(true)
          const wrongCompany = decryptToString(TEST_MASTER_KEY_BYTES, 'cmp_other', ciphertext, {
            aad: Buffer.from(item.id)
          })
          expect(Either.isLeft(wrongCompany)).toBe(true)

          const events =
            yield* sql`SELECT type FROM events WHERE company_id = ${acme.id} AND type LIKE 'vault.%'`.pipe(
              Effect.flatMap(Schema.decodeUnknown(TypeRows))
            )
          expect(events.map((e) => e.type)).toEqual(['vault.item.created'])
          state.item = item
        })
    )

    // ── subscriptions ────────────────────────────────────────────────────────

    it.effect('subscriptions.add validates the credential kind, runs detect, and is admin+', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const item = need(state.item, 'item')

        const openai = yield* owner.api.vault.add({
          payload: {
            kind: 'openai.api_key',
            label: 'OpenAI',
            secret: Redacted.make('sk-openai-1234')
          }
        })
        const wrongKind = yield* Effect.flip(
          owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'bad', credentialId: openai.id }
          })
        )
        expect(wrongKind._tag).toBe('Validation')
        yield* owner.api.vault.revoke({ path: { vaultItemId: openai.id } })

        const denied = yield* Effect.flip(
          dana.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'nope', credentialId: item.id }
          })
        )
        expect(denied._tag).toBe('Forbidden')

        const seat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Claude Code — Acme', credentialId: item.id }
        })
        expect(['ok', 'binary-missing']).toContain(seat.status)
        expect(seat.lastCheckedAt).toBeDefined()
        expect(seat.weight).toBe(1)
        expect(seat.tasksToday).toBe(0)

        const checked = yield* owner.api.subscriptions.check({ path: { subscriptionId: seat.id } })
        expect(checked.status).toBe(seat.status)
        const weighted = yield* owner.api.subscriptions.setWeight({
          path: { subscriptionId: seat.id },
          payload: { weight: 2 }
        })
        expect(weighted.weight).toBe(2)
        const listed = yield* dana.api.subscriptions.list({ urlParams: {} })
        expect(listed.items.map((s) => s.id)).toEqual([seat.id])
        state.seat = weighted
      })
    )

    // ── agents ───────────────────────────────────────────────────────────────

    it.effect(
      'agents.create: head creates in own department, admin anywhere; handle Conflict; home layout',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const acme = need(state.acme, 'acme')
          const engineering = need(state.engineering, 'engineering')
          const design = need(state.design, 'design')
          const seat = need(state.seat, 'seat')
          const config = yield* AppConfig

          const noDepartment = yield* Effect.flip(
            dana.api.agents.create({
              payload: {
                handle: 'rogue',
                name: 'Rogue',
                avatar,
                role: 'x',
                mandate: 'x',
                runtimeKind: 'claude-code',
                permissionMode: 'plan'
              }
            })
          )
          expect(noDepartment._tag).toBe('Forbidden')
          const otherDepartment = yield* Effect.flip(
            dana.api.agents.create({
              payload: {
                handle: 'rogue',
                name: 'Rogue',
                avatar,
                role: 'x',
                mandate: 'x',
                runtimeKind: 'claude-code',
                permissionMode: 'plan',
                departmentId: engineering.id
              }
            })
          )
          expect(otherDepartment._tag).toBe('Forbidden')

          const mila = yield* dana.api.agents.create({
            payload: {
              handle: 'mila',
              name: 'Mila',
              avatar: { kind: 'emoji', value: '🎨' },
              role: 'Designer',
              mandate: 'Design things.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: design.id
            }
          })
          expect(mila.handle).toBe('mila')

          const bruno = yield* owner.api.agents.create({
            payload: {
              handle: 'bruno',
              name: 'Bruno',
              avatar: { kind: 'emoji', value: '🦫' },
              role: 'Backend engineer',
              mandate: '# Mandate\n\nReview PRs. Never push to main.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              pinnedSubscriptionId: seat.id,
              departmentId: engineering.id
            }
          })
          expect(bruno.pinnedSubscriptionId).toBe(seat.id)
          expect(bruno.permissionMode).toBe('plan')

          const duplicate = yield* Effect.flip(
            owner.api.agents.create({
              payload: {
                handle: 'bruno',
                name: 'Bruno 2',
                avatar,
                role: 'x',
                mandate: 'x',
                runtimeKind: 'claude-code',
                permissionMode: 'plan'
              }
            })
          )
          expect(duplicate._tag).toBe('Conflict')

          const home = agentHomePath(config.dataDir, acme.slug, 'bruno')
          for (const sub of ['skills', 'inbox', 'work', 'memory', 'repos', '.taut']) {
            expect(existsSync(join(home, sub))).toBe(true)
          }
          // Built-in skills land on disk and in `agent_skills` (src/agents/defaultSkills.ts).
          const slopMd = readFileSync(join(home, 'skills', 'no-ai-slop', 'SKILL.md'), 'utf8')
          expect(slopMd.startsWith('---\nname: no-ai-slop\ndescription: "Write chat')).toBe(true)
          expect(slopMd).toContain('Does not apply to: code, code comments')
          const humanizerMd = readFileSync(join(home, 'skills', 'humanizer', 'SKILL.md'), 'utf8')
          expect(humanizerMd.startsWith('---\nname: humanizer\ndescription: "Strip AI')).toBe(true)
          expect(humanizerMd).toContain('Not X but Y')
          const fresh = yield* owner.api.agents.get({ path: { agentId: bruno.id } })
          expect(fresh.skills.map((s) => s.name)).toEqual(['humanizer', 'no-ai-slop'])

          const agentMd = readFileSync(join(home, 'AGENT.md'), 'utf8')
          expect(agentMd).toContain('# Bruno (@bruno)')
          expect(agentMd).toContain('> Backend engineer')
          expect(agentMd).toContain('Never push to main.')

          // Joined its department's channels: #engineering has bruno as an agent member.
          const channels = yield* owner.api.channels.list({ urlParams: {} })
          const engineeringChannel = need(
            channels.items.find((c) => c.name === 'engineering'),
            '#engineering'
          )
          const members = yield* owner.api.channels.members({
            path: { channelId: engineeringChannel.id },
            urlParams: {}
          })
          expect(
            members.items.some((m) => m.memberKind === 'agent' && m.memberId === bruno.id)
          ).toBe(true)
          const department = yield* owner.api.departments.get({
            path: { departmentId: engineering.id }
          })
          expect(
            department.members.some((m) => m.memberKind === 'agent' && m.memberId === bruno.id)
          ).toBe(true)

          // Agents are DM-able members.
          const dm = yield* dana.api.channels.dm({
            payload: { memberKind: 'agent', memberId: bruno.id }
          })
          expect(dm.kind).toBe('dm')

          const listed = yield* dana.api.agents.list({ urlParams: {} })
          expect(listed.items.map((a) => a.handle)).toEqual(['mila', 'bruno'])
          // `Agent.departmentIds` comes from department_members (list + get + create).
          expect(listed.items.map((a) => [...a.departmentIds])).toEqual([
            [design.id],
            [engineering.id]
          ])
          expect([...bruno.departmentIds]).toEqual([engineering.id])
          const detail = yield* dana.api.agents.get({ path: { agentId: mila.id } })
          expect([...detail.agent.departmentIds]).toEqual([design.id])
          Object.assign(state, { bruno, mila, home })
        })
    )

    it.effect(
      'agents.update: head of another department is Forbidden; mandate rewrites AGENT.md',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const bruno = need(state.bruno, 'bruno')
          const home = need(state.home, 'home')

          const denied = yield* Effect.flip(
            dana.api.agents.update({ path: { agentId: bruno.id }, payload: { role: 'Hacker' } })
          )
          expect(denied._tag).toBe('Forbidden')
          const deniedDelete = yield* Effect.flip(
            dana.api.agents.delete({ path: { agentId: bruno.id } })
          )
          expect(deniedDelete._tag).toBe('Forbidden')

          // A resumed runtime session replays the old mandate, so editing it must drop them.
          const sql = yield* SqlClient.SqlClient
          // A session is keyed by its thread (docs/build-plan-sessions.md D1), so the stale row
          // needs a real thread root to hang off.
          const [anyChannel] = yield* sql`SELECT id, company_id FROM channels LIMIT 1`
          const channelId = String(anyChannel?.id)
          const companyId = String(anyChannel?.company_id)
          const threadRoot = 'msg_stale_thread_root'
          yield* sql`INSERT INTO messages (id, company_id, channel_id, author_kind, author_id, body, status, created_at)
            VALUES (${threadRoot}, ${companyId}, ${channelId}, 'agent', ${bruno.id}, 'root', 'sent',
                    '2026-01-01T00:00:00.000Z')`
          yield* sql`INSERT INTO agent_sessions (agent_id, thread_id, channel_id, runtime, session_id, updated_at)
            VALUES (${bruno.id}, ${threadRoot}, ${channelId}, 'claude-code', 'sess_stale',
                    '2026-01-01T00:00:00.000Z')`

          const updated = yield* owner.api.agents.update({
            path: { agentId: bruno.id },
            payload: {
              mandate: 'New mandate body.',
              model: 'claude-sonnet-4-5',
              pinnedSubscriptionId: null
            }
          })
          expect(
            yield* sql`SELECT session_id FROM agent_sessions WHERE agent_id = ${bruno.id}`
          ).toEqual([])
          // The seeded thread root is scaffolding, not part of the fixture the later tests read.
          yield* sql`DELETE FROM messages WHERE id = ${threadRoot}`
          expect(updated.mandate).toBe('New mandate body.')
          expect(updated.model).toBe('claude-sonnet-4-5')
          expect(updated.pinnedSubscriptionId).toBeUndefined()
          expect(readFileSync(join(home, 'AGENT.md'), 'utf8')).toContain('New mandate body.')

          const badPin = yield* Effect.flip(
            owner.api.agents.update({
              path: { agentId: bruno.id },
              payload: { pinnedSubscriptionId: 'sub_does-not-exist' as Subscription['id'] }
            })
          )
          expect(badPin._tag).toBe('NotFound')
          state.bruno = updated
        })
    )

    it.effect('skills.put writes skills/<name>/SKILL.md with frontmatter; delete removes it', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const bruno = need(state.bruno, 'bruno')
        const home = need(state.home, 'home')

        const skill = yield* owner.api.agents.putSkill({
          path: { agentId: bruno.id, name: 'review-pr' },
          payload: { description: 'Review a pull request', body: '# Steps\n\n1. Read the diff.' }
        })
        expect(skill).toMatchObject({ agentId: bruno.id, name: 'review-pr' })
        const file = join(home, 'skills', 'review-pr', 'SKILL.md')
        const md = readFileSync(file, 'utf8')
        expect(
          md.startsWith('---\nname: review-pr\ndescription: "Review a pull request"\n---\n')
        ).toBe(true)
        expect(md).toContain('1. Read the diff.')

        const detail = yield* owner.api.agents.get({ path: { agentId: bruno.id } })
        // The built-ins are seeded on create (src/agents/defaultSkills.ts).
        expect(detail.skills.map((s) => s.name)).toEqual(['humanizer', 'no-ai-slop', 'review-pr'])

        // getSkill: any member reads the body back without the frontmatter.
        const dana = need(state.dana, 'dana')
        const read = yield* dana.api.agents.getSkill({
          path: { agentId: bruno.id, name: 'review-pr' }
        })
        expect(read).toMatchObject({
          agentId: bruno.id,
          name: 'review-pr',
          description: 'Review a pull request',
          body: '# Steps\n\n1. Read the diff.\n'
        })
        const unknownSkill = yield* Effect.flip(
          owner.api.agents.getSkill({ path: { agentId: bruno.id, name: 'nope' } })
        )
        expect(unknownSkill._tag).toBe('NotFound')

        yield* owner.api.agents.deleteSkill({ path: { agentId: bruno.id, name: 'review-pr' } })
        expect(existsSync(file)).toBe(false)
        const gone = yield* Effect.flip(
          owner.api.agents.deleteSkill({ path: { agentId: bruno.id, name: 'review-pr' } })
        )
        expect(gone._tag).toBe('NotFound')
      })
    )

    it.effect('built-in skills are on every agent and refuse edits and deletes', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const bruno = need(state.bruno, 'bruno')

        // An owner-authored skill sits alongside the built-ins and is not one of them.
        yield* owner.api.agents.putSkill({
          path: { agentId: bruno.id, name: 'triage' },
          payload: { description: 'Triage an incident', body: '1. Read the alert.\n' }
        })

        const listed = (yield* owner.api.agents.get({ path: { agentId: bruno.id } })).skills
        for (const name of ['no-ai-slop', 'humanizer']) {
          expect(listed.find((s) => s.name === name)?.builtin).toBe(true)
        }
        expect(listed.find((s) => s.name === 'triage')?.builtin).toBe(false)

        // Even an owner cannot rewrite or remove one.
        const edited = yield* Effect.flip(
          owner.api.agents.putSkill({
            path: { agentId: bruno.id, name: 'humanizer' },
            payload: { description: 'House style', body: '# Ours\n\nShort sentences.' }
          })
        )
        expect(edited._tag).toBe('Forbidden')
        const deleted = yield* Effect.flip(
          owner.api.agents.deleteSkill({ path: { agentId: bruno.id, name: 'no-ai-slop' } })
        )
        expect(deleted._tag).toBe('Forbidden')

        // The body is still readable through the same viewer, flagged built-in.
        const detail = yield* owner.api.agents.getSkill({
          path: { agentId: bruno.id, name: 'humanizer' }
        })
        expect(detail.builtin).toBe(true)
        expect(detail.body).toContain('Not X but Y')
      })
    )

    it.effect('ensureBuiltinSkills restores a built-in edited out of band', () =>
      Effect.gen(function* () {
        const home = need(state.home, 'home')
        const service = yield* Agents
        const file = join(home, 'skills', 'no-ai-slop', 'SKILL.md')

        // Matching the source: the boot pass is a no-op.
        expect(yield* service.ensureBuiltinSkills()).toBe(0)

        // Someone edits the markdown on disk; the next boot puts it back.
        writeFileSync(file, '---\nname: no-ai-slop\ndescription: "x"\n---\n\n# Ours\n')
        expect(yield* service.ensureBuiltinSkills()).toBe(1)
        expect(readFileSync(file, 'utf8')).toContain('Does not apply to: code, code comments')
        expect(yield* service.ensureBuiltinSkills()).toBe(0)
      })
    )

    it.effect('files: list, upload into inbox (multipart), and every escape is Forbidden', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const bruno = need(state.bruno, 'bruno')
        const home = need(state.home, 'home')
        const { http } = yield* baseUrl

        const root = yield* owner.api.agents.listFiles({
          path: { agentId: bruno.id },
          urlParams: {}
        })
        expect(root.items.filter((e) => e.kind === 'dir').map((e) => e.path)).toEqual([
          '.taut',
          'inbox',
          'memory',
          'repos',
          'skills',
          'work'
        ])
        expect(root.items.find((e) => e.path === 'AGENT.md')?.kind).toBe('file')

        const upload = (client: TestClient, path: string) =>
          Effect.gen(function* () {
            const form = new FormData()
            form.append('path', path)
            form.append('file', new Blob(['hello bruno'], { type: 'text/plain' }), 'notes.txt')
            const cookie = yield* client.cookieHeader
            return yield* Effect.promise(() =>
              fetch(`${http}/api/agents/${bruno.id}/files`, {
                method: 'POST',
                headers: { cookie },
                body: form
              })
            )
          })

        // A member (dana, not bruno's head) may drop files into inbox only.
        const uploaded = yield* upload(dana, 'inbox')
        expect(uploaded.status).toBe(201)
        const entry = (yield* Effect.promise(() => uploaded.json())) as {
          path: string
          size: number
        }
        expect(entry).toMatchObject({ path: 'inbox/notes.txt', size: 11 })
        expect(readFileSync(join(home, 'inbox', 'notes.txt'), 'utf8')).toBe('hello bruno')
        const elsewhere = yield* upload(dana, 'work')
        expect(elsewhere.status).toBe(403)
        const escape = yield* upload(owner, '../../escape')
        expect(escape.status).toBe(403)

        const inbox = yield* owner.api.agents.listFiles({
          path: { agentId: bruno.id },
          urlParams: { path: 'inbox' }
        })
        expect(inbox.items.map((e) => e.path)).toEqual(['inbox/notes.txt'])

        for (const bad of ['..', '../..', '/etc', 'work/../../..']) {
          const denied = yield* Effect.flip(
            owner.api.agents.listFiles({ path: { agentId: bruno.id }, urlParams: { path: bad } })
          )
          expect(denied._tag, bad).toBe('Forbidden')
        }

        // A symlink inside the home pointing outside is an escape too.
        symlinkSync(outside, join(home, 'work', 'escape'))
        const viaLink = yield* Effect.flip(
          owner.api.agents.listFiles({
            path: { agentId: bruno.id },
            urlParams: { path: 'work/escape' }
          })
        )
        expect(viaLink._tag).toBe('Forbidden')
        const viaLinkUpload = yield* upload(owner, 'work/escape')
        expect(viaLinkUpload.status).toBe(403)
        expect(readdirSync(outside)).toEqual([])
      })
    )

    it.effect('file grants (absolute paths)', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const bruno = need(state.bruno, 'bruno')

        const relative = yield* Effect.flip(
          owner.api.agents.grantFile({
            path: { agentId: bruno.id },
            payload: { path: 'repos/acme', mode: 'ro' }
          })
        )
        expect(relative._tag).toBe('Validation')
        const grant = yield* owner.api.agents.grantFile({
          path: { agentId: bruno.id },
          payload: { path: '/srv/repos/acme', mode: 'rw' }
        })
        expect(grant).toMatchObject({ agentId: bruno.id, path: '/srv/repos/acme', mode: 'rw' })

        const detail = yield* owner.api.agents.get({ path: { agentId: bruno.id } })
        expect(detail.fileGrants).toHaveLength(1)

        yield* owner.api.agents.revokeFileGrant({
          path: { agentId: bruno.id },
          urlParams: { path: '/srv/repos/acme' }
        })
        expect((yield* owner.api.agents.get({ path: { agentId: bruno.id } })).fileGrants).toEqual(
          []
        )
      })
    )

    // ── resolveForSpawn ──────────────────────────────────────────────────────

    it.effect(
      'Vault.resolveForSpawn: a company item is usable by every agent of the company; audited',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const item = need(state.item, 'item')
          const seat = need(state.seat, 'seat')
          const bruno = need(state.bruno, 'bruno')
          const mila = need(state.mila, 'mila')
          const home = need(state.home, 'home')
          const vault = yield* Vault
          const sql = yield* SqlClient.SqlClient

          // mila holds nothing in particular: a company item resolves for any agent of the company.
          const viaCompany = yield* vault.resolveForSpawn(item.id, mila.id)
          expect(Redacted.value(viaCompany.secret)).toBe(SECRET)
          expect(viaCompany.injection).toEqual({ via: 'env', envVar: 'ANTHROPIC_API_KEY' })
          expect(String(viaCompany.secret)).not.toContain(SECRET)

          // bruno via the subscription he is about to run on (recorded in the audit line).
          const viaSubscription = yield* vault.resolveForSpawn(item.id, bruno.id, {
            subscriptionId: seat.id
          })
          expect(Redacted.value(viaSubscription.secret)).toBe(SECRET)
          expect(viaSubscription.item.lastUsedBy).toBe(bruno.id)
          expect(viaSubscription.item.lastUsedAt).toBeDefined()

          const audits =
            yield* sql`SELECT COUNT(*) AS n FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id = ${item.id} AND purpose = 'spawn'`.pipe(
              Effect.flatMap(Schema.decodeUnknown(CountRows))
            )
          expect(need(audits[0], 'count').n).toBe(2)
          const log = readFileSync(join(home, '.taut', 'audit.log'), 'utf8')
          expect(log.trim().split('\n')).toHaveLength(1)
          expect(log).toContain(`spawn vault=${item.id} task=- subscription=${seat.id}`)
          expect(log).not.toContain(SECRET)

          // Nothing leaks through the metadata endpoints after use either.
          const listed = yield* owner.api.vault.list({ urlParams: {} })
          expect(JSON.stringify(listed)).not.toContain(SECRET)
          expect(listed.items[0]?.lastUsedBy).toBe(bruno.id)
        })
    )

    // ── pool rotation ────────────────────────────────────────────────────────

    it.effect(
      'Subscriptions.pick rotates: lowest tasksToday → highest weight; cooldown; weight 0 drains; pinned',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const item = need(state.item, 'item')
          const a = need(state.seat, 'seat')
          const subscriptions = yield* Subscriptions
          const sql = yield* SqlClient.SqlClient

          const b = yield* owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'seat B', credentialId: item.id, weight: 1 }
          })
          const c = yield* owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'seat C', credentialId: item.id, weight: 3 }
          })
          // Detection depends on the host; force every seat healthy for a deterministic pool.
          yield* sql`UPDATE subscriptions SET status = 'ok' WHERE company_id = ${acme.id}`
          yield* sql`UPDATE subscriptions SET tasks_today = 2, tasks_today_date = ${new Date().toISOString().slice(0, 10)} WHERE id = ${a.id}`

          // A has 2 tasks today, B and C have 0 → highest weight among the tied: C (3) over B (1).
          expect((yield* subscriptions.pick(acme.id, 'claude-code')).id).toBe(c.id)
          const used = yield* subscriptions.markUsed(acme.id, c.id)
          expect(used.tasksToday).toBe(1)
          // Now B is the only one at 0.
          expect((yield* subscriptions.pick(acme.id, 'claude-code')).id).toBe(b.id)
          // B rate-limited → cooling down → C (1) beats A (2).
          const cooled = yield* subscriptions.markRateLimited(acme.id, b.id, 60_000)
          expect(cooled.cooldownUntil).toBeDefined()
          expect((yield* subscriptions.pick(acme.id, 'claude-code')).id).toBe(c.id)
          // Pinned to a cooling-down seat is not silently rotated.
          const pinnedCooling = yield* Effect.flip(subscriptions.pick(acme.id, 'claude-code', b.id))
          expect(pinnedCooling._tag).toBe('RuntimeUnavailable')
          // C drained (weight 0) → A is what is left.
          yield* owner.api.subscriptions.setWeight({
            path: { subscriptionId: c.id },
            payload: { weight: 0 }
          })
          expect((yield* subscriptions.pick(acme.id, 'claude-code')).id).toBe(a.id)
          // Pinned to A still works while it is eligible.
          expect((yield* subscriptions.pick(acme.id, 'claude-code', a.id)).id).toBe(a.id)
          // Pool exhausted for another runtime.
          const none = yield* Effect.flip(subscriptions.pick(acme.id, 'codex'))
          expect(none._tag).toBe('RuntimeUnavailable')

          // tasksToday belongs to a UTC day: a stale counter reads as 0 and is reset on pick.
          yield* sql`UPDATE subscriptions SET tasks_today = 7, tasks_today_date = '2000-01-01' WHERE id = ${a.id}`
          const listed = yield* owner.api.subscriptions.list({ urlParams: {} })
          expect(listed.items.find((s) => s.id === a.id)?.tasksToday).toBe(0)
          const picked = yield* subscriptions.pick(acme.id, 'claude-code')
          expect(picked.id).toBe(a.id)
          expect(picked.tasksToday).toBe(0)
          const rows =
            yield* sql`SELECT tasks_today, tasks_today_date FROM subscriptions WHERE id = ${a.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(TasksTodayRows))
            )
          expect(need(rows[0], 'row')).toEqual({
            tasks_today: 0,
            tasks_today_date: new Date().toISOString().slice(0, 10)
          })
          state.seats = [a, b, c]
        })
    )

    // ── tasks ────────────────────────────────────────────────────────────────

    it.effect('tasks: list/get respect channel visibility; cancel ends the task once', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const bob = need(state.bob, 'bob')
        const acme = need(state.acme, 'acme')
        const bruno = need(state.bruno, 'bruno')
        const tasks = yield* Tasks

        const channels = yield* owner.api.channels.list({ urlParams: {} })
        const engineering = need(
          channels.items.find((c) => c.name === 'engineering'),
          '#engineering'
        )
        const message = yield* owner.api.messages.create({
          payload: {
            channelId: engineering.id,
            body: 'please review #42 (task created by hand below; a real @mention now schedules one — see phase4.test.ts)'
          }
        })
        const created = yield* tasks.create(acme.id, {
          agentId: bruno.id,
          channelId: engineering.id,
          threadId: message.id,
          messageId: message.id,
          status: 'running'
        })
        expect(created.status).toBe('running')
        expect(created.channelKind).toBe('channel')

        const all = yield* owner.api.tasks.list({ urlParams: {} })
        expect(all.items.map((t) => t.id)).toEqual([created.id])
        expect(all.items[0]?.channelKind).toBe('channel')
        const byAgent = yield* dana.api.tasks.list({ urlParams: { agentId: bruno.id } })
        expect(byAgent.items).toHaveLength(1)
        const bobsView = yield* bob.api.tasks.list({ urlParams: {} })
        expect(bobsView.items).toEqual([])
        const bobGet = yield* Effect.flip(bob.api.tasks.get({ path: { taskId: created.id } }))
        expect(bobGet._tag).toBe('Forbidden')
        const missing = yield* Effect.flip(
          owner.api.tasks.get({ path: { taskId: 'tsk_nope' as typeof created.id } })
        )
        expect(missing._tag).toBe('NotFound')

        const cancelled = yield* dana.api.tasks.cancel({ path: { taskId: created.id } })
        expect(cancelled.status).toBe('cancelled')
        expect(cancelled.endedAt).toBeDefined()
        const twice = yield* Effect.flip(owner.api.tasks.cancel({ path: { taskId: created.id } }))
        expect(twice._tag).toBe('Conflict')
        const done = yield* owner.api.tasks.list({ urlParams: { status: 'cancelled' } })
        expect(done.items.map((t) => t.status)).toEqual(['cancelled'])

        const updated = yield* tasks.update(acme.id, created.id, {
          error: 'boom',
          status: 'failed'
        })
        expect(updated).toMatchObject({ status: 'failed', error: 'boom' })
      })
    )

    // ── revoke cascade + delete ──────────────────────────────────────────────

    it.effect(
      'vault.revoke cascades to subscriptions; agents.delete archives the agent and its DMs',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const acme = need(state.acme, 'acme')
          const item = need(state.item, 'item')
          const seats = need(state.seats, 'seats')
          const bruno = need(state.bruno, 'bruno')
          const mila = need(state.mila, 'mila')
          const home = need(state.home, 'home')
          const agentsService = yield* Agents
          const sql = yield* SqlClient.SqlClient

          yield* owner.api.agents.update({
            path: { agentId: bruno.id },
            payload: { pinnedSubscriptionId: need(seats[0], 'a').id }
          })
          yield* owner.api.vault.revoke({ path: { vaultItemId: item.id } })
          const revokedAgain = yield* Effect.flip(
            owner.api.vault.revoke({ path: { vaultItemId: item.id } })
          )
          expect(revokedAgain._tag).toBe('NotFound')
          expect((yield* owner.api.vault.list({ urlParams: {} })).items).toEqual([])
          expect((yield* owner.api.subscriptions.list({ urlParams: {} })).items).toEqual([])
          const detail = yield* owner.api.agents.get({ path: { agentId: bruno.id } })
          expect(detail.agent.pinnedSubscriptionId).toBeUndefined()

          const types =
            yield* sql`SELECT type FROM events WHERE company_id = ${acme.id} AND type IN ('vault.item.revoked', 'subscription.deleted') ORDER BY seq`.pipe(
              Effect.flatMap(Schema.decodeUnknown(TypeRows))
            )
          expect(types.map((t) => t.type).slice(-4)).toEqual([
            'subscription.deleted',
            'subscription.deleted',
            'subscription.deleted',
            'vault.item.revoked'
          ])
          const revokeAudit =
            yield* sql`SELECT COUNT(*) AS n FROM audit_log WHERE vault_item_id = ${item.id} AND purpose = 'revoke'`.pipe(
              Effect.flatMap(Schema.decodeUnknown(CountRows))
            )
          expect(need(revokeAudit[0], 'count').n).toBe(1)

          // Phase 4 hook: the home path helper.
          expect(yield* agentsService.homeOf(acme.id, bruno.id)).toBe(home)

          // Archiving, not deleting: the DM is filed away with the agent and the history stays.
          const danaUser = (yield* dana.api.auth.me()).user
          const milaDm = yield* dana.api.channels.dm({
            payload: { memberKind: 'agent', memberId: mila.id }
          })
          // Inserted straight into the table: `messages.create` would wake the scheduler, and a
          // task running mid-archive makes the assertions below race it.
          yield* sql`
          INSERT INTO messages (id, company_id, channel_id, thread_id, author_kind, author_id,
                                body, status, created_at)
          VALUES ('msg_mila_dm', ${acme.id}, ${milaDm.id}, NULL, 'user', ${danaUser.id},
                  'ping', 'sent', '2026-01-01T00:00:00.000Z')`

          // dana heads design → may archive mila.
          const config = yield* AppConfig
          const milaHome = agentHomePath(config.dataDir, acme.slug, 'mila')
          expect(existsSync(milaHome)).toBe(true)
          yield* dana.api.agents.delete({ path: { agentId: mila.id } })

          // Dana opened the DM, so Dana is the one who can see it: a DM is visible to its two
          // members and to nobody else, admin or not (`Channels.canView`).
          const archivedDm = yield* dana.api.channels.get({ path: { channelId: milaDm.id } })
          expect(archivedDm.archivedAt).toBeDefined()
          const dmRows =
            yield* sql`SELECT COUNT(*) AS n FROM messages WHERE channel_id = ${milaDm.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(CountRows))
            )
          expect(need(dmRows[0], 'count').n).toBe(1)
          const posting = yield* Effect.flip(
            dana.api.messages.create({ payload: { channelId: milaDm.id, body: 'still there?' } })
          )
          expect(posting._tag).toBe('Forbidden')

          // The agent, its home and its place in the department all stay put.
          expect(existsSync(milaHome)).toBe(true)
          const stillThere = yield* owner.api.agents.get({ path: { agentId: mila.id } })
          expect(stillThere.agent.archivedAt).toBeDefined()
          const remaining = yield* owner.api.agents.list({ urlParams: {} })
          // `agents.list` orders by `created_at`, and @mila was created first; archiving does not move her.
          expect(remaining.items.map((a) => a.handle)).toEqual(['mila', 'bruno'])
          const design = need(state.design, 'design')
          const designDetail = yield* owner.api.departments.get({
            path: { departmentId: design.id }
          })
          expect(designDetail.members.some((m) => m.memberId === mila.id)).toBe(true)

          // …and unarchiving brings the conversation back with it.
          yield* dana.api.agents.update({
            path: { agentId: mila.id },
            payload: { archived: false }
          })
          const back = yield* dana.api.channels.get({ path: { channelId: milaDm.id } })
          expect(back.archivedAt).toBeUndefined()
          expect(
            (yield* owner.api.agents.get({ path: { agentId: mila.id } })).agent.archivedAt
          ).toBeUndefined()
        })
    )
  })
})
