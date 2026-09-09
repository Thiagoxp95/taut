import { SqlClient, SqlSchema } from '@effect/sql'
import { Event, type EventBody } from '@taut/contract/events'
import { CompanyId } from '@taut/contract/ids'
import { Chunk, DateTime, Effect, Either, Option, ParseResult, Schema, Stream } from 'effect'

const EventRow = Schema.Struct({
  seq: Schema.Number,
  company_id: Schema.String,
  at: Schema.String,
  type: Schema.String,
  payload_json: Schema.parseJson(Schema.Unknown)
})

const decodeEvent = Schema.decodeUnknown(Event)
const encodeEvent = Schema.encode(Event)

const toEvent = (row: typeof EventRow.Type) =>
  decodeEvent({
    seq: row.seq,
    companyId: row.company_id,
    at: row.at,
    type: row.type,
    payload: row.payload_json
  })

const REPLAY_PAGE = 500

/** `path: message` per issue (`payload.message.seq: is missing`), capped at 200 chars for logs. */
const describeParseError = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ')
    .slice(0, 200)

/**
 * Append-only, per-company, gap-free event log (agent-model.md §8), typed with the
 * contract's `Event` union: payloads are encoded with the schema on the way in
 * (dates → ISO) and decoded on the way out.
 *
 * `append` assigns `seq = MAX(seq)+1` for the company in the same statement as the
 * insert, so it is atomic on its own and also correct inside a caller's
 * `sql.withTransaction` (every mutation must append in the same transaction as its
 * write). Publishing to `Bus` is deliberately NOT done here: publish after commit
 * (see `EventPublisher`).
 */
export class EventLog extends Effect.Service<EventLog>()('EventLog', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const insert = SqlSchema.findAll({
      Request: Schema.Struct({
        companyId: Schema.String,
        at: Schema.String,
        type: Schema.String,
        payloadJson: Schema.String
      }),
      Result: EventRow,
      execute: (r) => sql`
        INSERT INTO events (company_id, seq, at, type, payload_json)
        SELECT ${r.companyId}, COALESCE(MAX(seq), 0) + 1, ${r.at}, ${r.type}, ${r.payloadJson}
        FROM events WHERE company_id = ${r.companyId}
        RETURNING seq, company_id, at, type, payload_json`
    })

    const page = SqlSchema.findAll({
      Request: Schema.Struct({
        companyId: Schema.String,
        after: Schema.Number,
        limit: Schema.Number
      }),
      Result: EventRow,
      execute: (r) => sql`
        SELECT seq, company_id, at, type, payload_json FROM events
        WHERE company_id = ${r.companyId} AND seq > ${r.after}
        ORDER BY seq ASC LIMIT ${r.limit}`
    })

    const latest = SqlSchema.single({
      Request: Schema.String,
      Result: Schema.Struct({ seq: Schema.Number }),
      execute: (companyId) =>
        sql`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE company_id = ${companyId}`
    })

    const append = (companyId: CompanyId, body: EventBody) =>
      Effect.gen(function* () {
        const at = new Date()
        const encoded = yield* encodeEvent({
          seq: 0,
          companyId,
          at: DateTime.unsafeFromDate(at),
          ...body
        })
        const rows = yield* insert({
          companyId,
          at: encoded.at,
          type: body.type,
          payloadJson: JSON.stringify(encoded.payload)
        })
        const row = rows[0]
        if (!row) return yield* Effect.dieMessage('events INSERT … RETURNING produced no row')
        return yield* toEvent(row)
      }).pipe(Effect.withSpan('EventLog.append', { attributes: { companyId, type: body.type } }))

    /**
     * Decode one row leniently: a row whose payload no longer matches the contract (written
     * by an older schema, before a migration caught up) is logged once and skipped, never
     * failing the stream. `append` stays strict — new rows always match.
     */
    const decodeRow = (row: typeof EventRow.Type) =>
      toEvent(row).pipe(
        Effect.map(Option.some),
        Effect.catchAll((error) =>
          Effect.logWarning(
            `events: skipping undecodable row seq=${row.seq} type=${row.type} (${row.company_id}): ${describeParseError(error)}`
          ).pipe(Effect.as(Option.none<Event>()))
        )
      )

    const decodeRows = (rows: ReadonlyArray<typeof EventRow.Type>) =>
      Effect.forEach(rows, decodeRow).pipe(
        Effect.map((decoded) => decoded.flatMap((o) => (Option.isSome(o) ? [o.value] : [])))
      )

    /**
     * Events with `seq > since`, in order, paged so long replays stay bounded. Rows that no
     * longer decode against the contract are skipped (one warning each) so one legacy row
     * can never take down a `/ws?since=0` replay, the memory ingest or the agent inbox.
     */
    const since = (companyId: CompanyId, since: number) =>
      Stream.paginateChunkEffect(since, (after) =>
        page({ companyId, after, limit: REPLAY_PAGE }).pipe(
          Effect.flatMap((rows) =>
            decodeRows(rows).pipe(
              Effect.map((events) => {
                const last = rows[rows.length - 1]
                const next =
                  rows.length === REPLAY_PAGE && last
                    ? Option.some(last.seq)
                    : Option.none<number>()
                return [Chunk.fromIterable(events), next] as const
              })
            )
          )
        )
      )

    const scan = SqlSchema.findAll({
      Request: Schema.Struct({ afterRowid: Schema.Number, limit: Schema.Number }),
      Result: Schema.Struct({ rowid: Schema.Number, ...EventRow.fields }),
      execute: (r) => sql`
        SELECT rowid, seq, company_id, at, type, payload_json FROM events
        WHERE rowid > ${r.afterRowid} ORDER BY rowid ASC LIMIT ${r.limit}`
    })

    /**
     * Startup check: decode every row of every company and count the ones `since` will
     * skip. Logs one summary warning when there are any (per-row detail is at debug level
     * here; the replay itself warns per row when it actually skips one).
     */
    const validate = () =>
      Effect.gen(function* () {
        let total = 0
        let invalid = 0
        const byType: Record<string, number> = {}
        let afterRowid = 0
        for (;;) {
          const rows = yield* scan({ afterRowid, limit: REPLAY_PAGE })
          for (const row of rows) {
            total += 1
            const result = yield* Effect.either(toEvent(row))
            if (Either.isLeft(result)) {
              invalid += 1
              byType[row.type] = (byType[row.type] ?? 0) + 1
              yield* Effect.logDebug(
                `events: undecodable row seq=${row.seq} type=${row.type} (${row.company_id}): ${describeParseError(result.left)}`
              )
            }
          }
          const last = rows[rows.length - 1]
          if (rows.length < REPLAY_PAGE || !last) break
          afterRowid = last.rowid
        }
        const report = { total, invalid, byType } as const
        if (invalid > 0) {
          const detail = Object.entries(byType)
            .map(([type, n]) => `${type}×${n}`)
            .join(', ')
          yield* Effect.logWarning(
            `events: ${invalid} legacy events will be skipped on replay (${detail}; ${total} rows checked) — a migration should repair them`
          )
        } else {
          yield* Effect.logDebug(`events: ${total} rows decode against the current contract`)
        }
        return report
      }).pipe(Effect.withSpan('EventLog.validate'))

    yield* validate()

    const latestSeq = (companyId: CompanyId) => latest(companyId).pipe(Effect.map((r) => r.seq))

    return { append, since, latestSeq, validate } as const
  })
}) {}
