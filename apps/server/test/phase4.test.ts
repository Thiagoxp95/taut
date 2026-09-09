/**
 * Phase 4 end to end against a fake machine provider (`_fakeRuntime.ts`): the real scheduler,
 * task runner, claude-code adapter/parser/redactor, agent-runtime API and memory ingest, with
 * scripted NDJSON instead of a spawned `claude`.
 */
import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Channel, Company, Department, Message, Task } from '@taut/contract/domain'
import type { AgentId, SubscriptionId, UserId } from '@taut/contract/ids'
import { Duration, Effect, Option, Redacted, Schema } from 'effect'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import { MemoryIngest } from '../src/agents/memoryIngest.js'
import { TaskTokens } from '../src/agents/tokens.js'
import {
  DEPTH_NOTE,
  CROSS_DEPARTMENT_NOTE,
  Scheduler,
  TURN_CAP,
  TURN_CAP_NOTE
} from '../src/agents/scheduler.js'
import { Channels } from '../src/services/channels.js'
import { EventPublisher } from '../src/services/publisher.js'
import { Messages } from '../src/services/messages.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testApp, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const
const GOOD_SECRET = 'sk-ant-api03-good-seat-000000000000000000'
const LIMITED_SECRET = 'sk-ant-api03-ratelimit-seat-0000000000000'

const state: {
  owner?: TestClient
  dana?: TestClient
  ownerId?: UserId
  danaId?: UserId
  acme?: Company
  engineering?: Department
  design?: Department
  engineeringChannel?: Channel
  designChannel?: Channel
  dm?: Channel
  bruno?: Agent
  mila?: Agent
  goodSeatId?: string
  limitedSeatId?: string
  token?: string
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const EventRows = Schema.Array(
  Schema.Struct({ seq: Schema.Number, type: Schema.String, payload_json: Schema.String })
)

/** Poll `probe` until it returns `Some`, or fail after `timeoutMs`. */
const waitFor = <A, E, R>(
  what: string,
  probe: Effect.Effect<Option.Option<A>, E, R>,
  timeoutMs = 10_000
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = yield* probe
      if (Option.isSome(found)) return found.value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      yield* Effect.sleep(Duration.millis(50))
    }
  })

const taskFor = (agentId: AgentId, triggerId: string) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const acme = need(state.acme, 'acme')
    return yield* scheduler.taskOf(acme.id, agentId, triggerId as Task['messageId'])
  })

const endedTask = (agentId: AgentId, triggerId: string, timeoutMs = 10_000) =>
  waitFor(
    `task of ${triggerId} to end`,
    taskFor(agentId, triggerId).pipe(
      Effect.map(
        Option.filter(
          (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'
        )
      )
    ),
    timeoutMs
  )

const replyOf = (task: Task) =>
  Effect.gen(function* () {
    const messages = yield* Messages
    const acme = need(state.acme, 'acme')
    return yield* messages.byId(acme.id, task.messageId).pipe(Effect.map(Option.getOrThrow))
  })

const eventsSince = (seq: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const acme = need(state.acme, 'acme')
    const rows =
      yield* sql`SELECT seq, type, payload_json FROM events WHERE company_id = ${acme.id} AND seq > ${seq} ORDER BY seq ASC`.pipe(
        Effect.flatMap(Schema.decodeUnknown(EventRows))
      )
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>
    }))
  })

/** Raw call to `/api/agent-runtime/*` with a bearer token. */
const runtimeCall = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const client = yield* HttpClient.HttpClient
    const url = `${http}/api/agent-runtime${path}`
    const request =
      method === 'GET'
        ? HttpClientRequest.get(url)
        : yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body ?? {}))
    const response = yield* client.execute(
      request.pipe(HttpClientRequest.setHeader('authorization', `Bearer ${token}`))
    )
    const json = (yield* response.json) as Record<string, unknown>
    return { status: response.status, json }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layer))

describe('phase 4 (scheduler → task run → streaming reply → agent-runtime API → memory)', () => {
  layer(testAppWith(dir, fake.layer, { TAUT_MAX_CONCURRENT_TASKS: '2' }), {
    excludeTestServices: true
  })((it) => {
    it.effect(
      'setup: company, two departments, seats, agents bruno (engineering) and mila (design)',
      () =>
        Effect.gen(function* () {
          const owner = yield* makeClient
          yield* owner.api.auth.signup({
            payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
          })
          const acme = yield* owner.api.companies.create({
            payload: { slug: 'acme', name: 'Acme', avatar }
          })
          const me = yield* owner.api.auth.me()
          const invite = yield* owner.api.invites.create({
            payload: { email: 'dana@taut.local', role: 'member' }
          })
          const dana = yield* makeClient
          const accepted = yield* dana.api.invites.accept({
            payload: { token: invite.token, name: 'Dana', password: 'password123' }
          })
          const engineering = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
          })
          const design = yield* owner.api.departments.create({
            payload: { name: 'Design', slug: 'design', headUserId: accepted.user.id }
          })

          const good = yield* owner.api.vault.add({
            payload: {
              kind: 'anthropic.api_key',
              label: 'good',
              secret: Redacted.make(GOOD_SECRET)
            }
          })
          const goodSeat = yield* owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'Good seat', credentialId: good.id }
          })
          // `add` ran `which claude` on this host; the fake machine has the binary regardless.
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${goodSeat.id}`

          const bruno = yield* owner.api.agents.create({
            payload: {
              handle: 'bruno',
              name: 'Bruno',
              avatar,
              role: 'Backend engineer',
              mandate: '# Mandate\n\nAnswer briefly.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: engineering.id
            }
          })
          yield* owner.api.agents.putSkill({
            path: { agentId: bruno.id, name: 'review-pr' },
            payload: { description: 'Review a PR', body: '# Steps\n1. Read the diff.' }
          })
          const mila = yield* owner.api.agents.create({
            payload: {
              handle: 'mila',
              name: 'Mila',
              avatar,
              role: 'Designer',
              mandate: '# Mandate\n\nDesign things.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: design.id
            }
          })
          const channels = yield* owner.api.channels.list({ urlParams: {} })
          const engineeringChannel = need(
            channels.items.find((c) => c.name === 'engineering'),
            '#engineering'
          )
          const designChannel = need(
            channels.items.find((c) => c.name === 'design'),
            '#design'
          )
          const dm = yield* owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: bruno.id }
          })
          Object.assign(state, {
            owner,
            dana,
            ownerId: me.user.id,
            danaId: accepted.user.id,
            acme,
            engineering,
            design,
            engineeringChannel,
            designChannel,
            dm,
            bruno,
            mila,
            goodSeatId: goodSeat.id
          })
        })
    )

    it.effect(
      'DM → task → streaming message grows in order → done → notification to the human',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dm = need(state.dm, 'dm')
          const bruno = need(state.bruno, 'bruno')
          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'reply with exactly: pong' }
          })
          const task = yield* endedTask(bruno.id, trigger.id)
          expect(task.status).toBe('done')
          expect(task.subscriptionId).toBe(state.goodSeatId)
          expect(task.endedAt).toBeDefined()

          const reply = yield* replyOf(task)
          expect(reply.authorKind).toBe('agent')
          expect(reply.authorId).toBe(bruno.id)
          expect(reply.status).toBe('sent')
          expect(reply.body).toBe('pong')
          // A thread is a session (docs/build-plan-sessions.md D2): a DM reply opens a thread
          // on the message that triggered it, so the next turn resumes instead of starting cold.
          expect(reply.threadId).toBe(trigger.id)
          expect(reply.channelId).toBe(dm.id)

          // Event order: created(user) < started(streaming) < delta… < done < notification(agent_done).
          const events = yield* eventsSince(trigger.seq - 1)
          const types = events.map((e) => e.type)
          const idx = (t: string) => types.indexOf(t)
          expect(idx('message.created')).toBeGreaterThanOrEqual(0)
          expect(idx('agent.task.started')).toBeGreaterThan(idx('message.created'))
          expect(idx('agent.task.delta')).toBeGreaterThan(idx('agent.task.started'))
          expect(idx('agent.task.done')).toBeGreaterThan(idx('agent.task.delta'))
          const started = need(
            events.find((e) => e.type === 'agent.task.started'),
            'started'
          )
          expect((started.payload['message'] as Message).status).toBe('streaming')
          expect((started.payload['message'] as Message).body).toBe('')
          const deltas = events
            .filter((e) => e.type === 'agent.task.delta')
            .map((e) => e.payload['delta'] as string)
          expect(deltas.join('')).toBe('pong')
          const presence = events
            .filter((e) => e.type === 'presence.changed')
            .map((e) => e.payload['state'])
          expect(presence).toEqual(['working', 'idle'])
          const notification = events.find(
            (e) =>
              e.type === 'notification' &&
              (e.payload['notification'] as { kind: string; userId: string }).kind === 'agent_done'
          )
          expect(notification).toBeDefined()
          expect(
            (need(notification, 'n').payload['notification'] as { userId: string }).userId
          ).toBe(state.ownerId)

          // What the runtime saw: the prompt carries the trigger, the secret only in env, redactor active.
          const exec = need(fake.execs[fake.execs.length - 1], 'exec')
          expect(exec.cmd[0]).toBe('claude')
          expect(exec.cmd).toContain('--mcp-config')
          expect(exec.stdin).toContain('[dm] @owner: reply with exactly: pong')
          expect(exec.stdin).toContain('Reply as @bruno')
          expect(exec.env['ANTHROPIC_API_KEY']).toBe(GOOD_SECRET)
          expect(exec.stdin).not.toContain(GOOD_SECRET)
          const claudeMd = [...fake.files.entries()].find(([p]) =>
            p.endsWith(`/work/${task.threadId}/CLAUDE.md`)
          )
          expect(need(claudeMd, 'CLAUDE.md')[1]).toContain('## Taut')
          expect(need(claudeMd, 'CLAUDE.md')[1]).toContain('@bruno')
          expect(need(claudeMd, 'CLAUDE.md')[1]).toContain('review-pr')
          const mcp = need(fake.mcpConfigs().pop(), 'mcp config')
          expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
          expect(mcp.token).toMatch(/^[0-9a-f]{64}$/)
          expect(mcp.taskId).toBe(task.id)
          state.token = mcp.token
        })
    )

    it.effect('rate limit on the first seat → cooldown, retry once on the second seat', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dm = need(state.dm, 'dm')
        const bruno = need(state.bruno, 'bruno')
        const limited = yield* owner.api.vault.add({
          payload: {
            kind: 'anthropic.api_key',
            label: 'limited',
            secret: Redacted.make(LIMITED_SECRET)
          }
        })
        const limitedSeat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Limited seat', credentialId: limited.id }
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${limitedSeat.id}`
        state.limitedSeatId = limitedSeat.id
        const before = fake.execs.length

        // tasksToday: good = 1, limited = 0 → the limited seat is picked first.
        const trigger = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'pong please' }
        })
        const task = yield* endedTask(bruno.id, trigger.id)
        expect(task.status).toBe('done')
        expect(task.subscriptionId).toBe(state.goodSeatId)
        expect((yield* replyOf(task)).body).toBe('pong')

        const attempts = fake.execs.slice(before)
        expect(attempts).toHaveLength(2)
        expect(attempts[0]?.env['ANTHROPIC_API_KEY']).toBe(LIMITED_SECRET)
        expect(attempts[1]?.env['ANTHROPIC_API_KEY']).toBe(GOOD_SECRET)

        const seats = yield* owner.api.subscriptions.list({ urlParams: {} })
        const cooled = need(
          seats.items.find((s) => s.id === limitedSeat.id),
          'limited seat'
        )
        expect(cooled.cooldownUntil).toBeDefined()
        expect(cooled.status).toBe('ok')
      })
    )

    /**
     * A limit is per-model but a cooldown parks the whole seat, so an operator
     * who knows the other models still have room needs a way out that does not
     * go through the provider.
     */
    it.effect('clearCooldown puts a parked seat straight back in the rotation', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const seatId = need(state.limitedSeatId, 'limited seat id') as SubscriptionId
        const before = yield* owner.api.subscriptions.list({ urlParams: {} })
        expect(
          need(
            before.items.find((s) => s.id === seatId),
            'seat'
          ).cooldownUntil
        ).toBeDefined()

        const cleared = yield* owner.api.subscriptions.clearCooldown({
          path: { subscriptionId: seatId }
        })
        expect(cleared.cooldownUntil).toBeUndefined()

        const after = yield* owner.api.subscriptions.list({ urlParams: {} })
        expect(
          need(
            after.items.find((s) => s.id === seatId),
            'seat'
          ).cooldownUntil
        ).toBeUndefined()
      })
    )

    it.effect('deltas arrive in order and concatenate to the final body', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dm = need(state.dm, 'dm')
        const bruno = need(state.bruno, 'bruno')
        const trigger = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'say it in two parts' }
        })
        const task = yield* endedTask(bruno.id, trigger.id)
        expect((yield* replyOf(task)).body).toBe('ping')
        const events = yield* eventsSince(trigger.seq)
        const deltas = events
          .filter((e) => e.type === 'agent.task.delta' && e.payload['taskId'] === task.id)
          .map((e) => e.payload['delta'] as string)
        expect(deltas.length).toBeGreaterThanOrEqual(2)
        expect(deltas).toEqual(['pi', 'ng'])
      })
    )

    it.effect('tasks.cancel interrupts the runtime and fails the streaming message', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dm = need(state.dm, 'dm')
        const bruno = need(state.bruno, 'bruno')
        const before = fake.execs.length
        const trigger = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'please hang forever' }
        })
        const running = yield* waitFor(
          'task running',
          taskFor(bruno.id, trigger.id).pipe(
            Effect.map(Option.filter((t) => t.status === 'running'))
          )
        )
        const hanging = yield* waitFor(
          'exec started',
          Effect.sync(() =>
            Option.fromNullable(
              fake.execs.slice(before).find((e) => e.stdin?.includes('hang forever'))
            )
          )
        )
        const cancelled = yield* owner.api.tasks.cancel({ path: { taskId: running.id } })
        expect(cancelled.status).toBe('cancelled')

        const reply = yield* waitFor(
          'reply failed',
          replyOf(running).pipe(
            Effect.map((m) => (m.status === 'failed' ? Option.some(m) : Option.none()))
          )
        )
        expect(reply.error).toBe('Cancelled.')
        yield* waitFor(
          'exec interrupted',
          Effect.sync(() => (hanging.interrupted ? Option.some(true) : Option.none()))
        )
        expect(fake.execs.slice(before)).toHaveLength(1) // the limited seat is cooling down: no retry
        const after = yield* owner.api.tasks.get({ path: { taskId: running.id } })
        expect(after.status).toBe('cancelled')
        expect(after.channelKind).toBe('dm')
        const scheduler = yield* Scheduler
        expect(yield* scheduler.runningTaskIds).not.toContain(running.id)
        // A later DM still works (the agent's queue is free again).
        const next = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'pong?' }
        })
        expect((yield* endedTask(bruno.id, next.id)).status).toBe('done')
      })
    )

    it.effect(
      'agent-runtime API: send routes by §9 (403 cross_department across departments), inbox, memory',
      () =>
        Effect.gen(function* () {
          const token = need(state.token, 'token')
          const dm = need(state.dm, 'dm')
          const bruno = need(state.bruno, 'bruno')

          const toMila = yield* runtimeCall(token, 'POST', '/send', { to: '@mila', text: 'hi' })
          expect(toMila.status).toBe(403)
          expect((toMila.json['error'] as { code: string }).code).toBe('cross_department')

          // The boundary also holds for an @-mention of a foreign agent inside an allowed send.
          const mentioning = yield* runtimeCall(token, 'POST', '/send', {
            to: '@owner',
            text: 'looping in @mila on this'
          })
          expect(mentioning.status).toBe(403)
          expect((mentioning.json['error'] as { code: string }).code).toBe('cross_department')

          const toDesign = yield* runtimeCall(token, 'POST', '/send', { to: '#design', text: 'hi' })
          expect(toDesign.status).toBe(403)

          const toDana = yield* runtimeCall(token, 'POST', '/send', { to: '@dana', text: 'hi' })
          expect(toDana.status).toBe(403)

          const toOwner = yield* runtimeCall(token, 'POST', '/send', {
            to: '@owner',
            text: 'all done'
          })
          expect(toOwner.status).toBe(200)
          expect(toOwner.json['channelId']).toBe(dm.id)
          const messages = yield* Messages
          const acme = need(state.acme, 'acme')
          const sent = yield* messages
            .byId(acme.id, toOwner.json['messageId'] as Message['id'])
            .pipe(Effect.map(Option.getOrThrow))
          expect(sent.authorId).toBe(bruno.id)
          expect(sent.body).toBe('@owner all done')

          const noAuth = yield* runtimeCall('nope', 'GET', '/inbox')
          expect(noAuth.status).toBe(401)
          const inbox = yield* runtimeCall(token, 'GET', '/inbox?since=0')
          expect(inbox.status).toBe(200)
          const items = inbox.json['items'] as Array<{ text: string; from: { handle: string } }>
          expect(items.some((i) => i.text === 'pong please' && i.from.handle === 'owner')).toBe(
            true
          )

          // Symmetry: a foreign-department agent's message never reaches this inbox either,
          // not even in a channel both of them can see and with an explicit @mention.
          const mila = need(state.mila, 'mila')
          yield* messages
            .postAsAgent(acme.id, {
              agentId: mila.id,
              channelId: dm.id,
              body: '@bruno can you take this',
              requireMembership: false
            })
            .pipe(Effect.orDie)
          const afterMila = yield* runtimeCall(token, 'GET', '/inbox?since=0')
          const milaItems = afterMila.json['items'] as Array<{ from: { handle: string } }>
          expect(milaItems.some((i) => i.from.handle === 'mila')).toBe(false)

          const bad = yield* runtimeCall(token, 'POST', '/send', { to: 'owner', text: '' })
          expect(bad.status).toBe(422)

          const note = yield* runtimeCall(token, 'POST', '/memory/note', {
            text: 'remember the pong',
            tags: ['t']
          })
          expect(note.status).toBe(200)
          const notes = yield* runtimeCall(token, 'GET', '/memory/notes')
          expect((notes.json['items'] as Array<unknown>).length).toBe(1)
        })
    )

    it.effect(
      "a refused cross-department attempt lands in the head's handover queue and can be raised",
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const bruno = need(state.bruno, 'bruno')
          const mila = need(state.mila, 'mila')
          const danaId = need(state.danaId, 'danaId')

          // The routing test above made two attempts (a send and an @mention) in one thread;
          // they collapse onto one row so a looping agent cannot flood its head.
          const open = yield* owner.api.handovers.list({ urlParams: { status: 'open' } })
          const mine = open.filter((h) => h.fromAgentId === bruno.id && h.toAgentId === mila.id)
          expect(mine.length).toBe(1)
          const handover = need(mine[0], 'handover')
          expect(handover.toHeadUserId).toBe(danaId)

          // Each head sees only their own agents' attempts: Dana (Design) gets mila's, never
          // bruno's — the mila → bruno mention in the DM above is hers.
          const danaOpen = yield* dana.api.handovers.list({ urlParams: { status: 'open' } })
          expect(danaOpen.every((h) => h.fromAgentId === mila.id)).toBe(true)
          expect(danaOpen.some((h) => h.id === handover.id)).toBe(false)
          const notMine = yield* Effect.flip(
            dana.api.handovers.raise({ path: { handoverId: handover.id }, payload: {} })
          )
          expect(notMine._tag).toBe('Forbidden')

          const raised = yield* owner.api.handovers.raise({
            path: { handoverId: handover.id },
            payload: {}
          })
          expect(raised.status).toBe('raised')

          // Raising it DMs the other head as the caller — nothing is unblocked for the agent.
          const dm = yield* dana.api.channels.dm({
            payload: { memberKind: 'user', memberId: need(state.ownerId, 'ownerId') }
          })
          const dmMessages = yield* dana.api.messages.list({
            urlParams: { channelId: dm.id }
          })
          const note = dmMessages.items.find((m) => m.id === raised.raisedMessageId)
          expect(note?.body).toContain('@bruno')
          expect(note?.body).toContain('@mila')

          const twice = yield* Effect.flip(
            owner.api.handovers.dismiss({ path: { handoverId: handover.id } })
          )
          expect(twice._tag).toBe('Conflict')
          expect(
            (yield* owner.api.handovers.list({ urlParams: { status: 'raised' } })).length
          ).toBe(1)
        })
    )

    it.effect(
      'memory ingest: only visible channels are indexed; own replies are; replay resumes from the cursor',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const engineering = need(state.engineeringChannel, '#engineering')
          const design = need(state.designChannel, '#design')
          const bruno = need(state.bruno, 'bruno')
          const mila = need(state.mila, 'mila')
          const ingest = yield* MemoryIngest

          yield* owner.api.messages.create({
            payload: {
              channelId: engineering.id,
              body: 'the deploy password rotation is on friday'
            }
          })
          yield* owner.api.messages.create({
            payload: { channelId: design.id, body: 'the new palette ships monday' }
          })
          const memoryOf = (id: AgentId) => ingest.memoryOf(id).pipe(Effect.map(Option.getOrThrow))
          const brunoMem = yield* memoryOf(bruno.id)
          const milaMem = yield* memoryOf(mila.id)
          const hits = (mem: typeof brunoMem, q: string) => mem.search(q).pipe(Effect.orDie)
          yield* waitFor(
            'bruno indexed #engineering',
            hits(brunoMem, 'rotation').pipe(
              Effect.map((h) => (h.length > 0 ? Option.some(h) : Option.none()))
            )
          )
          yield* waitFor(
            'mila indexed #design',
            hits(milaMem, 'palette').pipe(
              Effect.map((h) => (h.length > 0 ? Option.some(h) : Option.none()))
            )
          )
          expect(yield* hits(brunoMem, 'palette')).toHaveLength(0)
          expect(yield* hits(milaMem, 'rotation')).toHaveLength(0)
          // The agent's own final replies are indexed too (message.updated + agent.task.done).
          const own = yield* hits(brunoMem, 'pong')
          expect(own.some((h) => h.authorId === bruno.id && h.body === 'pong')).toBe(true)
          expect(
            existsSync(join(dir, 'companies', 'acme', 'agents', 'bruno', 'memory', 'memory.db'))
          ).toBe(true)

          // Stop, post while stopped, start again: the consumer replays from its cursor.
          yield* ingest.stop(bruno.id)
          yield* owner.api.messages.create({
            payload: { channelId: engineering.id, body: 'cursor replay marker zebra' }
          })
          yield* ingest.start(bruno.id)
          const reopened = yield* memoryOf(bruno.id)
          const replayed = yield* waitFor(
            'replayed after restart',
            hits(reopened, 'zebra').pipe(
              Effect.map((h) => (h.length > 0 ? Option.some(h) : Option.none()))
            )
          )
          expect(replayed[0]?.body).toBe('cursor replay marker zebra')
          expect(replayed[0]?.text).toContain('[#engineering]')
          expect(replayed[0]?.text).toContain('[@owner]')
        })
    )

    it.effect(
      'scheduler notes: a cross-department agent mention is blocked outright; the turn cap stops a thread',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const design = need(state.designChannel, '#design')
          const engineering = need(state.engineeringChannel, '#engineering')
          const bruno = need(state.bruno, 'bruno')
          const mila = need(state.mila, 'mila')
          const messages = yield* Messages
          const tasks = yield* Tasks

          // bruno joins #design so a mention there is otherwise deliverable.
          yield* owner.api.channels.addMember({
            path: { channelId: design.id },
            payload: { memberKind: 'agent', memberId: bruno.id }
          })
          const root = yield* owner.api.messages.create({
            payload: { channelId: design.id, body: 'design thread root' }
          })
          const fromMila = yield* messages.postAsAgent(acme.id, {
            agentId: mila.id,
            channelId: design.id,
            threadId: root.id,
            body: '@bruno can you help here?'
          })
          const note = yield* waitFor(
            'gate note',
            messages
              .recent(acme.id, design.id, root.id, 20)
              .pipe(
                Effect.map((ms) =>
                  Option.fromNullable(
                    ms.find(
                      (m) => m.authorId === bruno.id && m.body.includes(CROSS_DEPARTMENT_NOTE)
                    )
                  )
                )
              )
          )
          expect(note.threadId).toBe(root.id)
          expect(Option.isNone(yield* tasks.byTrigger(acme.id, bruno.id, fromMila.id))).toBe(true)
          expect(DEPTH_NOTE).toContain('depth')

          // Turn cap: 20 agent-authored messages already in the thread → note, no task.
          const capRoot = yield* owner.api.messages.create({
            payload: { channelId: engineering.id, body: 'busy thread' }
          })
          const sql = yield* SqlClient.SqlClient
          for (let i = 0; i < TURN_CAP; i++) {
            yield* sql`INSERT INTO messages (id, company_id, channel_id, thread_id, author_kind, author_id, body, status, seq, created_at)
            VALUES (${`msg_cap_${i}`}, ${acme.id}, ${engineering.id}, ${capRoot.id}, 'agent', ${bruno.id}, ${`turn ${i}`}, 'sent', 0, ${new Date().toISOString()})`
          }
          const capped = yield* owner.api.messages.create({
            payload: { channelId: engineering.id, threadId: capRoot.id, body: '@bruno one more' }
          })
          yield* waitFor(
            'turn cap note',
            messages
              .recent(acme.id, engineering.id, capRoot.id, 50)
              .pipe(
                Effect.map((ms) =>
                  Option.fromNullable(ms.find((m) => m.body.includes(TURN_CAP_NOTE)))
                )
              )
          )
          expect(Option.isNone(yield* tasks.byTrigger(acme.id, bruno.id, capped.id))).toBe(true)

          // A regular channel mention replies in a thread under the mention.
          const threaded = yield* owner.api.messages.create({
            payload: { channelId: engineering.id, body: '@bruno quick pong' }
          })
          const task = yield* endedTask(bruno.id, threaded.id)
          const reply = yield* replyOf(task)
          expect(reply.threadId).toBe(threaded.id)
          expect(reply.body).toBe('pong')
        })
    )

    it.effect('same-department agents reach each other anywhere, including a DM of their own', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const acme = need(state.acme, 'acme')
        const engineering = need(state.engineering, 'engineering')
        const engineeringChannel = need(state.engineeringChannel, '#engineering')
        const dm = need(state.dm, 'dm')
        const bruno = need(state.bruno, 'bruno')
        const messages = yield* Messages
        const tasks = yield* Tasks

        const nina = yield* owner.api.agents.create({
          payload: {
            handle: 'nina',
            name: 'Nina',
            avatar,
            role: 'Platform engineer',
            mandate: '# Mandate\n\nAnswer briefly.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: engineering.id
          }
        })

        // Top level in a shared channel — no thread, no task of its own: still delivered.
        const top = yield* messages.postAsAgent(acme.id, {
          agentId: bruno.id,
          channelId: engineeringChannel.id,
          body: '@nina pick a colour'
        })
        const spawned = yield* waitFor('nina task', tasks.byTrigger(acme.id, nina.id, top.id))
        expect(spawned.agentId).toBe(nina.id)
        const thread = yield* messages.recent(acme.id, engineeringChannel.id, top.id, 20)
        expect(thread.some((m) => m.body.includes(CROSS_DEPARTMENT_NOTE))).toBe(false)

        // Regression: nina's reply starts life as an empty `streaming` row, and dispatching
        // that woke bruno with a blank trigger — he read "@nina:" with nothing after it and
        // asked his question a second time. bruno must be woken by the finished reply, and
        // the prompt he gets must carry its text.
        const ninaDone = yield* endedTask(nina.id, top.id)
        const ninaReply = yield* replyOf(ninaDone)
        expect(ninaReply.body).toBe('pong')
        const carried = yield* waitFor(
          'bruno woken by the finished reply',
          tasks.byTrigger(acme.id, bruno.id, ninaReply.id)
        )
        expect(carried.agentId).toBe(bruno.id)
        yield* endedTask(bruno.id, ninaReply.id)
        const prompt = fake.execs.find((e) => e.stdin?.includes(`@nina: pong`))
        expect(prompt).toBeDefined()
        expect(fake.execs.some((e) => e.stdin?.includes('@nina: \n'))).toBe(false)

        // And the answer comes home: a reply in the thread bruno opened wakes bruno, with
        // no `@bruno` in it — nobody writes the handle when they are answering a question.
        const answer = yield* messages.postAsAgent(acme.id, {
          agentId: nina.id,
          channelId: engineeringChannel.id,
          threadId: top.id,
          body: 'Terminal green.'
        })
        const back = yield* waitFor('bruno task', tasks.byTrigger(acme.id, bruno.id, answer.id))
        expect(back.agentId).toBe(bruno.id)
        expect(back.threadId).toBe(top.id)

        // …and bruno can carry it home. Woken in #engineering, a send to the person who
        // asked lands in their DM with him, not under nina's reply where they would never
        // look — that is the whole "go ask him and come back to me" loop.
        const tokens = yield* TaskTokens
        const channelsOf = yield* Channels
        const channelToken = yield* tokens.mint({
          taskId: back.id,
          agentId: bruno.id,
          companyId: acme.id
        })
        const home = yield* runtimeCall(channelToken, 'POST', '/send', {
          to: '@owner',
          text: 'Nina says terminal green.'
        })
        expect(home.status).toBe(200)
        expect(home.json['channelId']).toBe(dm.id)

        // Directly, too. bruno's task is running in the human's DM, where nina is not a
        // member, so the send opens the bruno↔nina DM rather than refusing — the department
        // is the only boundary. It wakes nina with no `@` needed in a two-person room.
        const dmToken = need(state.token, 'token')
        const direct = yield* runtimeCall(dmToken, 'POST', '/send', {
          to: '@nina',
          text: 'and your second favourite?'
        })
        expect(direct.status).toBe(200)
        const directChannel = direct.json['channelId'] as Channel['id']
        expect(directChannel).not.toBe(engineeringChannel.id)
        expect(directChannel).not.toBe(dm.id)
        const opened = yield* channelsOf.find(acme.id, directChannel)
        expect(Option.isSome(opened) && opened.value.kind).toBe('dm')
        const members = yield* channelsOf.agentMembers(directChannel)
        expect([...members].sort()).toEqual([bruno.id, nina.id].sort())
        const woken = yield* waitFor(
          'nina task in the agent DM',
          tasks.byTrigger(acme.id, nina.id, direct.json['messageId'] as Message['id'])
        )
        expect(woken.channelId).toBe(directChannel)

        // The same send again reuses that DM instead of opening a second one.
        const again = yield* runtimeCall(dmToken, 'POST', '/send', {
          to: '@nina',
          text: 'still curious'
        })
        expect(again.json['channelId']).toBe(directChannel)

        // `taut_ask` must wait for a finished reply. Every agent task opens its answer as an
        // empty `streaming` row the moment it starts, and the ask used to match that and come
        // back `answered` with an empty string. quinn is paused so no run of his competes here.
        const quinn = yield* owner.api.agents.create({
          payload: {
            handle: 'quinn',
            name: 'Quinn',
            avatar,
            role: 'Platform engineer',
            mandate: '# Mandate\n\nAnswer briefly.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: engineering.id
          }
        })
        yield* owner.api.agents.update({
          path: { agentId: quinn.id },
          payload: { status: 'paused' }
        })
        const asked = yield* runtimeCall(dmToken, 'POST', '/ask', {
          to: '@quinn',
          text: 'blue or green?',
          timeoutSec: 1
        })
        expect(asked.status).toBe(200)
        const askId = asked.json['askId'] as string
        // Where the ask went: the same routing as a send, so bruno's own DM with quinn.
        const askChannel = yield* channelsOf.ensureDm(
          acme.id,
          { memberKind: 'agent', memberId: bruno.id },
          { memberKind: 'agent', memberId: quinn.id }
        )
        const publisher = yield* EventPublisher
        const ghost = yield* publisher.transact(acme.id, (emit) =>
          messages.createStreaming(emit, {
            companyId: acme.id,
            agentId: quinn.id,
            channelId: askChannel,
            threadId: null
          })
        )
        const early = yield* runtimeCall(dmToken, 'GET', `/ask/${askId}`)
        expect(early.json['status']).toBe('pending')

        // Same row, now finished: that is the answer.
        yield* publisher.transact(acme.id, (emit) =>
          messages.finalizeAgentMessage(emit, acme.id, ghost.id, {
            status: 'sent',
            appendBody: 'Green.'
          })
        )
        const settled = yield* runtimeCall(dmToken, 'GET', `/ask/${askId}?wait=3000`)
        expect(settled.json['status']).toBe('answered')
        const settledAnswer = settled.json['answer'] as { text: string; messageId: string }
        expect(settledAnswer.text).toBe('Green.')
        expect(settledAnswer.messageId).toBe(ghost.id)
      })
    )

    it.effect('task tokens expire 10 minutes after the task ends', () =>
      Effect.gen(function* () {
        const token = need(state.token, 'token')
        const sql = yield* SqlClient.SqlClient
        const hash = createHash('sha256').update(token).digest('hex')
        const rows = yield* sql<{
          expires_at: string | null
        }>`SELECT expires_at FROM task_tokens WHERE token_hash = ${hash}`
        const expiresAt = rows[0]?.expires_at ?? null
        expect(expiresAt).not.toBeNull()
        const delta = Date.parse(expiresAt ?? '') - Date.now()
        expect(delta).toBeGreaterThan(8 * 60 * 1000)
        expect(delta).toBeLessThanOrEqual(10 * 60 * 1000)

        expect((yield* runtimeCall(token, 'GET', '/memory/notes')).status).toBe(200)
        yield* sql`UPDATE task_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ${hash}`
        const expired = yield* runtimeCall(token, 'GET', '/memory/notes')
        expect(expired.status).toBe(401)
        expect((expired.json['error'] as { code: string }).code).toBe('unauthorized')
      })
    )

    it.effect('the answer to an errand comes back in the thread where it was asked', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const acme = need(state.acme, 'acme')
        const dm = need(state.dm, 'dm')
        const bruno = need(state.bruno, 'bruno')
        const messages = yield* Messages
        const tasks = yield* Tasks
        const roster = yield* owner.api.agents.list({ urlParams: {} })
        const nina = need(
          roster.items.find((a) => a.handle === 'nina'),
          'nina'
        )
        const tokens = yield* TaskTokens

        // The errand: the human asks in their DM with bruno, in a thread of their own.
        const errand = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'wait for release: go ask nina and come back' }
        })
        const asking = yield* waitFor('bruno task for the errand', taskFor(bruno.id, errand.id))
        const askToken = yield* tokens.mint({
          taskId: asking.id,
          agentId: bruno.id,
          companyId: acme.id
        })
        const out = yield* runtimeCall(askToken, 'POST', '/send', {
          to: '@nina',
          text: 'what is your favourite colour?'
        })
        expect(out.status).toBe(200)
        fake.release('pong')

        // nina answers; the finished answer wakes bruno in the nina DM, a thread the human
        // never opens. Sending the answer home must land under `errand`, not loose at the top
        // of the DM where it reads as a new topic.
        const ninaTask = yield* endedTask(nina.id, out.json['messageId'] as Message['id'])
        const ninaReply = yield* replyOf(ninaTask)
        const woken = yield* waitFor(
          'bruno woken by nina',
          tasks.byTrigger(acme.id, bruno.id, ninaReply.id)
        )
        expect(woken.channelId).not.toBe(dm.id)
        const homeToken = yield* tokens.mint({
          taskId: woken.id,
          agentId: bruno.id,
          companyId: acme.id
        })
        const home = yield* runtimeCall(homeToken, 'POST', '/send', {
          to: '@owner',
          text: 'Nina says terminal green.'
        })
        expect(home.status).toBe(200)
        expect(home.json['channelId']).toBe(dm.id)
        expect(home.json['threadId']).toBe(errand.id)
        const landed = yield* messages.byId(acme.id, home.json['messageId'] as Message['id'])
        expect(Option.isSome(landed) && landed.value.threadId).toBe(errand.id)
      })
    )

    it.effect('the agent home on disk keeps the Phase 3 layout next to the memory db', () =>
      Effect.sync(() => {
        // The fake provider writes task files in memory; the real home still has the Phase 3 layout.
        const home = join(dir, 'companies', 'acme', 'agents', 'bruno')
        expect(readFileSync(join(home, 'AGENT.md'), 'utf8')).toContain('@bruno')
        expect(existsSync(join(home, 'skills', 'review-pr', 'SKILL.md'))).toBe(true)
      })
    )
  })
})

// ── opt-in: a real `claude` through the LocalProvider with the host login ─────────────────
//
//   TAUT_TEST_CLAUDE=1 pnpm --filter @taut/server test -- phase4
//
// No subscription exists, so `TAUT_DEV_HOST_LOGIN=true` makes the runner fall back to the host
// user's own claude login (dev only). Asserts a non-empty final message containing "pong".

const realClaude = process.env['TAUT_TEST_CLAUDE'] === '1'
const realDir = makeTempDir()
afterAll(() => removeDir(realDir))

describe.skipIf(!realClaude)('phase 4 with a real claude (TAUT_TEST_CLAUDE=1)', () => {
  layer(testApp(realDir, { TAUT_DEV_HOST_LOGIN: 'true' }), { excludeTestServices: true })((it) => {
    it.effect(
      'DM @bruno "reply with exactly: pong" → a streaming message finalizes with pong',
      () =>
        Effect.gen(function* () {
          const owner = yield* makeClient
          yield* owner.api.auth.signup({
            payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
          })
          const acme = yield* owner.api.companies.create({
            payload: { slug: 'acme', name: 'Acme', avatar }
          })
          const me = yield* owner.api.auth.me()
          const engineering = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
          })
          const bruno = yield* owner.api.agents.create({
            payload: {
              handle: 'bruno',
              name: 'Bruno',
              avatar,
              role: 'Backend engineer',
              mandate: '# Mandate\n\nAnswer briefly and literally.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: engineering.id
            }
          })
          const dm = yield* owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: bruno.id }
          })
          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'reply with exactly: pong' }
          })
          const scheduler = yield* Scheduler
          const task = yield* waitFor(
            'real task to end',
            scheduler
              .taskOf(acme.id, bruno.id, trigger.id)
              .pipe(Effect.map(Option.filter((t) => t.status === 'done' || t.status === 'failed'))),
            150_000
          )
          const messages = yield* Messages
          const reply = yield* messages
            .byId(acme.id, task.messageId)
            .pipe(Effect.map(Option.getOrThrow))
          expect(task.status, `error: ${task.error ?? '-'} body: ${reply.body}`).toBe('done')
          expect(reply.status).toBe('sent')
          expect(reply.body.trim().length).toBeGreaterThan(0)
          expect(reply.body.toLowerCase()).toContain('pong')
        }),
      { timeout: 180_000 }
    )
  })
})
