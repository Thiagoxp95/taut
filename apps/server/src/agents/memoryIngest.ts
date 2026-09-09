/**
 * Per-agent memory consumers (docs/agent-model.md §10 "Ingestion"; `@taut/memory` CHANGELOG
 * "Running the memory ingest loop"). One fiber per agent: open `<home>/memory/memory.db`,
 * subscribe to the company bus, replay `events` with `seq > cursor` in batches of 500, then
 * follow live. Visibility = the agent is a member of the message's channel (`channel_members`);
 * `eventToMemoryOps` does the mapping, `AgentMemory.apply` commits rows + cursor together.
 * `agent.created` starts a consumer, `agent.deleted` stops it. The `/memory/*` routes reuse
 * the same open handle through `memoryOf(agentId)` — the token resolves to exactly one file.
 */
import { FileSystem } from '@effect/platform'
import type { Agent } from '@taut/contract/domain'
import type { Event } from '@taut/contract/events'
import type { AgentId, ChannelId, CompanyId, MemberId } from '@taut/contract/ids'
import { AgentMemory, cursorName, eventToMemoryOps, type MemoryOp } from '@taut/memory'
import { Chunk, Effect, Exit, Option, Scope, Stream } from 'effect'
import { join } from 'node:path'
import { Bus } from '../realtime/bus.js'
import { EventLog } from '../realtime/eventLog.js'
import { userHandle } from '../services/access.js'
import { Agents } from '../services/agents.js'
import { Channels } from '../services/channels.js'
import { Users } from '../services/users.js'

/** Events per `apply` while catching up. */
export const INGEST_BATCH = 500

interface Consumer {
  readonly agent: Agent
  readonly scope: Scope.CloseableScope
  readonly memory: AgentMemory
}

const channelIdsOf = (event: Event): ReadonlyArray<ChannelId> => {
  switch (event.type) {
    case 'message.created':
    case 'message.updated':
      return [event.payload.message.channelId]
    case 'agent.task.done':
      return [event.payload.message.channelId, event.payload.task.channelId]
    default:
      return []
  }
}

export class MemoryIngest extends Effect.Service<MemoryIngest>()('MemoryIngest', {
  scoped: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bus = yield* Bus
    const eventLog = yield* EventLog
    const agents = yield* Agents
    const channels = yield* Channels
    const users = yield* Users

    const consumers = new Map<AgentId, Consumer>()
    const channelNames = new Map<ChannelId, string>()
    const handles = new Map<string, string>()

    // ── names for the contextual prefix ─────────────────────────────────────

    const channelName = (
      companyId: CompanyId,
      channelId: ChannelId
    ): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const cached = channelNames.get(channelId)
        if (cached !== undefined) return cached
        const row = yield* channels.find(companyId, channelId)
        if (Option.isNone(row)) return undefined
        const name = row.value.kind === 'dm' ? 'dm' : row.value.name
        channelNames.set(channelId, name)
        return name
      })

    const memberHandle = (
      companyId: CompanyId,
      kind: 'user' | 'agent',
      id: MemberId
    ): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const key = `${kind}:${id}`
        const cached = handles.get(key)
        if (cached !== undefined) return cached
        const handle =
          kind === 'agent'
            ? yield* users
                .agentIn(companyId, id as AgentId)
                .pipe(Effect.map(Option.map((a) => a.handle)))
            : yield* users
                .byId(id as never)
                .pipe(Effect.map(Option.map((u) => userHandle(u.email))))
        if (Option.isNone(handle)) return undefined
        handles.set(key, handle.value)
        return handle.value
      })

    // ── one batch of events → one agent's DB ────────────────────────────────

    const applyBatch = (consumer: Consumer, events: ReadonlyArray<Event>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const last = events[events.length - 1]
        if (last === undefined) return
        const { agent, memory } = consumer
        const wanted = new Set(events.flatMap(channelIdsOf))
        const visible = new Set<string>()
        for (const channelId of wanted) {
          if (yield* channels.isMember(channelId, { memberKind: 'agent', memberId: agent.id })) {
            visible.add(channelId)
          }
        }
        const names = new Map<ChannelId, string | undefined>()
        for (const channelId of visible) {
          names.set(
            channelId as ChannelId,
            yield* channelName(agent.companyId, channelId as ChannelId)
          )
        }
        const memberNames = new Map<string, string | undefined>()
        const ops: Array<MemoryOp> = []
        for (const event of events) {
          if (event.type === 'channel.updated' || event.type === 'channel.deleted') {
            channelNames.delete(
              event.type === 'channel.updated' ? event.payload.channel.id : event.payload.channelId
            )
          }
          const authors: Array<readonly ['user' | 'agent', MemberId]> = []
          if (event.type === 'message.created' || event.type === 'message.updated') {
            authors.push([event.payload.message.authorKind, event.payload.message.authorId])
          } else if (event.type === 'agent.task.done') {
            authors.push([event.payload.message.authorKind, event.payload.message.authorId])
          }
          for (const [kind, id] of authors) {
            const key = `${kind}:${id}`
            if (!memberNames.has(key)) {
              memberNames.set(key, yield* memberHandle(agent.companyId, kind, id))
            }
          }
          ops.push(
            ...eventToMemoryOps(event, (channelId) => visible.has(channelId), {
              channel: (id) => names.get(id as ChannelId),
              member: (kind, id) => memberNames.get(`${kind}:${id}`)
            })
          )
        }
        yield* memory.apply(ops, { name: cursorName(agent.id), seq: last.seq }).pipe(Effect.orDie)
      })

    /** Replay from the cursor, then follow the bus. Runs inside the consumer's scope. */
    const loop = (consumer: Consumer): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { agent, memory } = consumer
        const queue = yield* bus.subscribe(agent.companyId)
        let cursor = yield* memory.getCursor(cursorName(agent.id)).pipe(Effect.orDie)
        yield* eventLog.since(agent.companyId, cursor).pipe(
          Stream.grouped(INGEST_BATCH),
          Stream.runForEach((chunk) => {
            const events = Chunk.toReadonlyArray(chunk)
            const last = events[events.length - 1]
            if (last !== undefined) cursor = last.seq
            return applyBatch(consumer, events)
          })
        )
        yield* Effect.logDebug(`memory: @${agent.handle} caught up to seq ${cursor}`)
        yield* Stream.fromQueue(queue).pipe(
          Stream.runForEach((m) => {
            if (m._tag !== 'Event' || m.event.seq <= cursor) return Effect.void
            cursor = m.event.seq
            return applyBatch(consumer, [m.event])
          })
        )
      }).pipe(
        Effect.scoped,
        Effect.catchAllCause((cause) =>
          Effect.logError(`memory: consumer for ${consumer.agent.id} died`, cause)
        ),
        Effect.annotateLogs({ agentId: consumer.agent.id })
      )

    // ── lifecycle ───────────────────────────────────────────────────────────

    const start = (agent: Agent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (consumers.has(agent.id)) return
        const home = yield* agents.homeOf(agent.companyId, agent.id)
        const dir = join(home, 'memory')
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
        const scope = yield* Scope.make()
        const memory = yield* AgentMemory.open(join(dir, 'memory.db')).pipe(
          Scope.extend(scope),
          Effect.orDie
        )
        const consumer: Consumer = { agent, scope, memory }
        consumers.set(agent.id, consumer)
        yield* Effect.forkIn(scope)(loop(consumer))
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(`memory: cannot start consumer for ${agent.id}`, cause)
        )
      )

    const stop = (agentId: AgentId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const consumer = consumers.get(agentId)
        if (consumer === undefined) return Effect.void
        consumers.delete(agentId)
        return Scope.close(consumer.scope, Exit.void)
      })

    yield* Effect.addFinalizer(() => Effect.forEach([...consumers.keys()], stop, { discard: true }))

    const all = yield* agents.all()
    yield* Effect.forEach(all, start, { discard: true })
    yield* Effect.logInfo(`memory: ingesting for ${all.length} agent(s)`)

    const watch = bus.streamAll().pipe(
      Stream.runForEach((m) => {
        if (m._tag !== 'Event') return Effect.void
        switch (m.event.type) {
          case 'agent.created':
            return start(m.event.payload.agent)
          case 'agent.deleted':
            return stop(m.event.payload.agentId)
          default:
            return Effect.void
        }
      }),
      Effect.catchAllCause((cause) => Effect.logError('memory: agent watcher died', cause))
    )
    yield* Effect.forkScoped(watch)

    const memoryOf = (agentId: AgentId): Effect.Effect<Option.Option<AgentMemory>> =>
      Effect.sync(() => Option.fromNullable(consumers.get(agentId)?.memory))

    const startById = (agentId: AgentId): Effect.Effect<void> =>
      agents.all().pipe(
        Effect.flatMap((list) => {
          const agent = list.find((a) => a.id === agentId)
          return agent === undefined ? Effect.void : start(agent)
        })
      )

    return {
      memoryOf,
      /** Stop and start again: replays from the stored cursor (tests, operators). */
      restart: (agentId: AgentId) => stop(agentId).pipe(Effect.zipRight(startById(agentId))),
      stop,
      start: startById
    } as const
  })
}) {}
