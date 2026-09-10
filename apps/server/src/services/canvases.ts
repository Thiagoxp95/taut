import { SqlClient } from '@effect/sql'
import type { Canvas, CanvasDocument } from '@taut/contract/domain'
import { MembershipRole } from '@taut/contract/domain'
import { NotFound, Validation } from '@taut/contract/errors'
import { AgentId, ChannelId, CompanyId, MessageId, type UserId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { findAll, nowIso } from '../db/sql.js'
import { Channels } from './channels.js'
import { EventPublisher } from './publisher.js'

export interface CanvasScope {
  readonly companyId: CompanyId
  readonly channelId: ChannelId
  readonly threadId: MessageId | undefined
  readonly agentId: AgentId
}

const Row = Schema.Struct({
  id: Schema.String,
  company_id: CompanyId,
  channel_id: ChannelId,
  thread_id: Schema.NullOr(MessageId),
  agent_id: AgentId,
  title: Schema.String,
  html: Schema.String,
  open: Schema.Number,
  revision: Schema.Number,
  updated_at: Schema.String
})
type Row = typeof Row.Type
const metadata = (r: Omit<Row, 'html'>): Canvas => ({
  id: r.id,
  title: r.title,
  channelId: r.channel_id,
  ...(r.thread_id === null ? {} : { threadId: r.thread_id }),
  agentId: r.agent_id,
  open: r.open !== 0,
  revision: r.revision,
  updatedAt: r.updated_at
})
const document = (r: Row): CanvasDocument => ({ ...metadata(r), html: r.html })
const invalid = (path: string, message: string) =>
  new Validation({ issues: [{ path: [path], message }] })
const validate = (input: { title?: string; html?: string }) =>
  Effect.gen(function* () {
    if (input.title !== undefined && (input.title.trim().length === 0 || input.title.length > 200))
      return yield* invalid('title', 'Use a title of 1–200 characters')
    if (
      input.html !== undefined &&
      (input.html.trim().length === 0 || Buffer.byteLength(input.html, 'utf8') > 1_000_000)
    )
      return yield* invalid('html', 'Use nonempty self-contained HTML up to 1 MB')
  })

/** The lifecycle seam. Callers supply a scope derived from a verified task, never tool input. */
export class Canvases extends Effect.Service<Canvases>()('Canvases', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    const channels = yield* Channels
    const rows = findAll({
      Request: Schema.Struct({ companyId: CompanyId, channelId: ChannelId }),
      Result: Row.omit('html'),
      execute: (r) =>
        sql`SELECT id, company_id, channel_id, thread_id, agent_id, title, open, revision, updated_at FROM canvases WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId} ORDER BY updated_at, id`
    })
    const getRow = (companyId: CompanyId, channelId: ChannelId, id: string) =>
      sql`SELECT * FROM canvases WHERE company_id = ${companyId} AND channel_id = ${channelId} AND id = ${id}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Row))),
        Effect.orDie,
        Effect.flatMap((found) =>
          found[0] === undefined
            ? Effect.fail(new NotFound({ entity: 'Canvas', id }))
            : Effect.succeed(found[0])
        )
      )
    const create = (scope: CanvasScope, input: { title: string; html: string; open?: boolean }) =>
      publisher.transact(scope.companyId, (emit) =>
        Effect.gen(function* () {
          yield* validate(input)
          const id = `cnv_${randomUUID()}`
          yield* sql`INSERT INTO canvases (id, company_id, channel_id, thread_id, agent_id, title, html, open, revision, updated_at)
          VALUES (${id}, ${scope.companyId}, ${scope.channelId}, ${scope.threadId ?? null}, ${scope.agentId}, ${input.title}, ${input.html}, ${input.open === false ? 0 : 1}, 1, ${nowIso()})`
          const canvas = metadata(yield* getRow(scope.companyId, scope.channelId, id))
          yield* emit({ type: 'canvas.changed', payload: { canvas, action: 'create' } })
          return canvas
        })
      )
    return {
      create,
      list: (companyId: CompanyId, channelId: ChannelId) =>
        rows({ companyId, channelId }).pipe(Effect.map((all) => all.map(metadata))),
      get: (companyId: CompanyId, channelId: ChannelId, id: string) =>
        getRow(companyId, channelId, id).pipe(Effect.map(document)),
      listOwn: (scope: CanvasScope) =>
        rows(scope).pipe(
          Effect.map((all) =>
            all
              .filter(
                (r) => r.agent_id === scope.agentId && r.thread_id === (scope.threadId ?? null)
              )
              .map(metadata)
          )
        ),
      change: (
        scope: CanvasScope,
        id: string,
        action: 'update' | 'open' | 'close',
        input: { title?: string; html?: string } = {}
      ) =>
        publisher.transact(scope.companyId, (emit) =>
          Effect.gen(function* () {
            const row = yield* getRow(scope.companyId, scope.channelId, id)
            if (row.agent_id !== scope.agentId || row.thread_id !== (scope.threadId ?? null))
              return yield* new NotFound({ entity: 'Canvas', id })
            if (action === 'update' && input.title === undefined && input.html === undefined)
              return yield* invalid('canvas', 'Supply title or html to update')
            yield* validate(input)
            const open = action === 'open' ? 1 : action === 'close' ? 0 : row.open
            yield* sql`UPDATE canvases SET title = ${input.title ?? row.title}, html = ${input.html ?? row.html}, open = ${open}, revision = revision + 1, updated_at = ${nowIso()} WHERE id = ${id} AND company_id = ${scope.companyId}`
            const canvas = metadata(yield* getRow(scope.companyId, scope.channelId, id))
            yield* emit({ type: 'canvas.changed', payload: { canvas, action } })
            return canvas
          })
        ),
      /** Reuse channel authorization for live delivery and replay; private DM titles stay private. */
      visibleTo: (companyId: CompanyId, channelId: ChannelId, userId: UserId) =>
        Effect.gen(function* () {
          const memberships =
            yield* sql`SELECT role FROM memberships WHERE company_id = ${companyId} AND user_id = ${userId}`.pipe(
              Effect.flatMap(
                Schema.decodeUnknown(Schema.Array(Schema.Struct({ role: MembershipRole })))
              ),
              Effect.orDie
            )
          const membership = memberships[0]
          if (membership === undefined) return false
          const result = yield* channels
            .get({ userId, activeCompanyId: companyId, role: membership.role }, channelId)
            .pipe(Effect.option)
          return Option.isSome(result)
        })
    } as const
  })
}) {}
