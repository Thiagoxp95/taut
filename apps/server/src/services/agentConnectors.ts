import { SqlClient } from '@effect/sql'
import type { AgentConnector, ConnectorInput, UpdateConnectorInput } from '@taut/contract/api'
import { NotFound, Validation } from '@taut/contract/errors'
import { AgentId, CompanyId } from '@taut/contract/ids'
import { Effect, Redacted, Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { AppConfig } from '../config.js'
import { findAll, nowIso } from '../db/sql.js'
import { decryptToString, encrypt } from '../vault/crypto.js'

const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  header_names_json: Schema.parseJson(Schema.Array(Schema.String)),
  headers_ciphertext: Schema.Uint8ArrayFromSelf
})
type Row = typeof Row.Type
const metadata = (row: Row): AgentConnector => ({
  id: row.id,
  name: row.name,
  url: row.url,
  headerNames: row.header_names_json
})
const invalid = (path: string, message: string) =>
  new Validation({ issues: [{ path: [path], message }] })

/** Validate before opening a connection or writing authentication to disk. */
const validate = (input: UpdateConnectorInput) =>
  Effect.gen(function* () {
    const name = input.name.trim()
    if (!name || name.length > 100)
      return yield* invalid('name', 'Use a connector name between 1 and 100 characters')
    const url = yield* Effect.try({
      try: () => new URL(input.url.trim()),
      catch: () => invalid('url', 'Enter a valid HTTP or HTTPS connector URL')
    })
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href.length > 2048
    ) {
      return yield* invalid(
        'url',
        'Use an HTTP or HTTPS URL without credentials, query parameters, or fragments'
      )
    }
    const entries = Object.entries(input.headers ?? {})
    if (entries.length > 32)
      return yield* invalid('headers', 'Use at most 32 authentication headers')
    const seen = new Set<string>()
    for (const [header, value] of entries) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
        header.length > 256 ||
        seen.has(header.toLowerCase())
      ) {
        return yield* invalid('headers', 'Header names must be valid and unique (case insensitive)')
      }
      if (/[\r\n\0]/.test(value) || value.length > 8192)
        return yield* invalid(
          'headers',
          'Header values cannot contain line breaks or exceed 8192 characters'
        )
      seen.add(header.toLowerCase())
    }
    return { name, url: url.href }
  })

/** Agent authorization and transactions belong to Agents; this module owns encrypted storage. */
export const makeAgentConnectors = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const config = yield* AppConfig
  const masterKey = Redacted.value(config.masterKey)
  const rowsOf = findAll({
    Request: AgentId,
    Result: Row,
    execute: (agentId) =>
      sql`SELECT id, name, url, header_names_json, headers_ciphertext FROM agent_connectors WHERE agent_id = ${agentId} ORDER BY created_at, rowid`
  })
  const load = (agentId: AgentId, id: string) =>
    rowsOf(agentId).pipe(
      Effect.flatMap((rows) => {
        const row = rows.find((candidate) => candidate.id === id)
        return row
          ? Effect.succeed(row)
          : Effect.fail(new NotFound({ entity: 'AgentConnector', id }))
      })
    )
  const add = (companyId: CompanyId, agentId: AgentId, input: ConnectorInput) =>
    Effect.gen(function* () {
      const clean = yield* validate(input)
      const id = randomUUID()
      const headers = encrypt(masterKey, companyId, JSON.stringify(input.headers), {
        aad: Buffer.from(id)
      })
      const names = Object.keys(input.headers)
      yield* sql`INSERT INTO agent_connectors (id, agent_id, name, url, header_names_json, headers_ciphertext, created_at) VALUES (${id}, ${agentId}, ${clean.name}, ${clean.url}, ${JSON.stringify(names)}, ${headers}, ${nowIso()})`.pipe(
        Effect.orDie
      )
      return { id, ...clean, headerNames: names }
    })
  const update = (
    companyId: CompanyId,
    agentId: AgentId,
    id: string,
    input: UpdateConnectorInput
  ) =>
    Effect.gen(function* () {
      const row = yield* load(agentId, id)
      const clean = yield* validate(input)
      const ciphertext =
        input.headers === undefined
          ? row.headers_ciphertext
          : encrypt(masterKey, companyId, JSON.stringify(input.headers), { aad: Buffer.from(id) })
      const names = input.headers === undefined ? row.header_names_json : Object.keys(input.headers)
      yield* sql`UPDATE agent_connectors SET name = ${clean.name}, url = ${clean.url}, header_names_json = ${JSON.stringify(names)}, headers_ciphertext = ${ciphertext} WHERE agent_id = ${agentId} AND id = ${id}`.pipe(
        Effect.orDie
      )
      return { id, ...clean, headerNames: names }
    })
  const remove = (agentId: AgentId, id: string) =>
    Effect.gen(function* () {
      yield* load(agentId, id)
      yield* sql`DELETE FROM agent_connectors WHERE agent_id = ${agentId} AND id = ${id}`.pipe(
        Effect.orDie
      )
    })
  const forRuntime = (
    agentId: AgentId
  ): Effect.Effect<Record<string, { url: string; headers: Readonly<Record<string, string>> }>> =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT company_id FROM agents WHERE id = ${agentId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknown(Schema.Array(Schema.Struct({ company_id: CompanyId })))
        ),
        Effect.orDie
      )
      if (!rows[0]) return {}
      const companyId = rows[0].company_id
      const entries = yield* Effect.forEach(yield* rowsOf(agentId), (row) =>
        Effect.gen(function* () {
          const plaintext = yield* decryptToString(masterKey, companyId, row.headers_ciphertext, {
            aad: Buffer.from(row.id)
          }).pipe(Effect.orDie)
          const headers = yield* Schema.decodeUnknown(
            Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.String }))
          )(plaintext).pipe(Effect.orDie)
          return [`connector_${row.id.replaceAll('-', '')}`, { url: row.url, headers }] as const
        })
      )
      return Object.fromEntries(entries)
    })
  return {
    validate,
    add,
    update,
    remove,
    forRuntime,
    list: (agentId: AgentId) => rowsOf(agentId).pipe(Effect.map((rows) => rows.map(metadata)))
  }
})
