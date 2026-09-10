import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Company, Department } from '@taut/contract/domain'
import type { MessageId } from '@taut/contract/ids'
import { ExecFailed, MachineProviderTag, type Machine } from '@taut/runtime'
import { Effect, Layer, Option, Redacted } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Scheduler } from '../src/agents/scheduler.js'
import { Messages } from '../src/services/messages.js'
import { makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const secret = 'connector-private-header-value-781234'
const otherSecret = 'another-agent-private-header-918273'
const connectorUrl = 'https://connector.example.com/mcp'
const avatar = { kind: 'emoji', value: 'A' } as const
const dir = makeTempDir()
afterAll(() => removeDir(dir))

// Real adapters consume their native event formats; no model process or HTTP MCP call runs.
const fake = makeFakeRuntime({
  exec: ({ cmd, stdin }) => {
    const text = (stdin ?? cmd.at(-1) ?? '').includes('after removal')
      ? 'Connector removed.'
      : `Connector replied with ${secret}`
    switch (cmd[0]) {
      case 'claude':
      case 'cursor-agent':
        return [
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
          JSON.stringify({ type: 'result', subtype: 'success', result: text, is_error: false })
        ]
      case 'codex':
        return [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
          JSON.stringify({ type: 'turn.completed' })
        ]
      case 'opencode':
        return [JSON.stringify({ type: 'text', part: { text } })]
      default:
        return undefined
    }
  }
})

let unwritableConfig: string | undefined
const failingWrites = Layer.effect(
  MachineProviderTag,
  Effect.map(MachineProviderTag, (provider) => ({
    ...provider,
    ensure: (spec) =>
      provider.ensure(spec).pipe(
        Effect.map((machine): Machine => ({
          ...machine,
          putFile: (path, content) =>
            path === unwritableConfig
              ? Effect.fail(
                  new ExecFailed({
                    agentId: spec.agentId,
                    cmd: ['putFile'],
                    reason: 'Disk is read-only'
                  })
                )
              : machine.putFile(path, content)
        }))
      )
  }))
).pipe(Layer.provide(fake.layer))

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing connector test fixture')
  return value
}
const state: { owner?: TestClient; company?: Company; department?: Department } = {}
const runtimes = [
  { runtime: 'claude-code', credential: 'anthropic.api_key', binary: 'claude' },
  { runtime: 'codex', credential: 'openai.api_key', binary: 'codex' },
  { runtime: 'cursor', credential: 'cursor.api_key', binary: 'cursor-agent' },
  { runtime: 'opencode', credential: 'anthropic.api_key', binary: 'opencode' }
] as const

describe('agent connectors through scheduler and runtime', () => {
  layer(testAppWith(dir, failingWrites, { TAUT_MCP_COMMAND: 'node /fake/mcp.js' }), {
    excludeTestServices: true
  })((it) => {
    it.effect('creates the company and runtime seats', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'connectors@taut.local', password: 'password123', name: 'Owner' }
        })
        const company = yield* owner.api.companies.create({
          payload: { slug: 'connectors', name: 'Connectors', avatar }
        })
        const me = yield* owner.api.auth.me()
        const department = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const sql = yield* SqlClient.SqlClient
        for (const { runtime, credential } of runtimes) {
          const entry = yield* owner.api.vault.add({
            payload: {
              kind: credential,
              label: runtime,
              secret: Redacted.make(`seat-${runtime}-secret`)
            }
          })
          const seat = yield* owner.api.subscriptions.add({
            payload: { runtime, label: runtime, credentialId: entry.id }
          })
          yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`
        }
        Object.assign(state, { owner, company, department })
      })
    )

    for (const { runtime, binary } of runtimes) {
      it.effect(
        `${runtime}: injects only this agent's connector, redacts output, and removes it next turn`,
        () =>
          Effect.gen(function* () {
            const owner = required(state.owner)
            const company = required(state.company)
            const agent = yield* owner.api.agents.create({
              payload: {
                handle: `agent-${runtime}`,
                name: runtime,
                avatar,
                role: 'Engineer',
                mandate: 'Answer briefly.',
                runtimeKind: runtime,
                permissionMode: 'plan',
                departmentId: required(state.department).id,
                browserAccess: false
              }
            })
            const other = yield* owner.api.agents.create({
              payload: {
                handle: `other-${runtime}`,
                name: 'Other',
                avatar,
                role: 'Engineer',
                mandate: 'Answer briefly.',
                runtimeKind: runtime,
                permissionMode: 'plan',
                departmentId: required(state.department).id,
                connectors: [
                  {
                    name: 'Other connector',
                    url: 'https://other.example.com/mcp',
                    headers: { 'X-API-Key': otherSecret }
                  }
                ]
              }
            })
            expect(other.id).not.toBe(agent.id)
            const connector = yield* owner.api.agents.addConnector({
              path: { agentId: agent.id },
              payload: {
                name: 'Custom connector',
                url: connectorUrl,
                headers: { 'X-API-Key': secret }
              }
            })
            const key = `connector_${connector.id.replaceAll('-', '')}`
            const dm = yield* owner.api.channels.dm({
              payload: { memberKind: 'agent', memberId: agent.id }
            })
            const scheduler = yield* Scheduler
            const messages = yield* Messages
            const run = (threadId?: MessageId, status: 'done' | 'failed' = 'done') =>
              Effect.gen(function* () {
                const trigger = yield* owner.api.messages.create({
                  payload: {
                    channelId: dm.id,
                    body: threadId === undefined ? 'Use my connector.' : 'Reply after removal.',
                    ...(threadId === undefined ? {} : { threadId })
                  }
                })
                for (let attempt = 0; attempt < 200; attempt++) {
                  const found = yield* scheduler.taskOf(company.id, agent.id, trigger.id)
                  if (
                    Option.isSome(found) &&
                    ['done', 'failed', 'cancelled'].includes(found.value.status)
                  ) {
                    expect(found.value.status, found.value.error).toBe(status)
                    return found.value
                  }
                  yield* Effect.sleep('50 millis')
                }
                throw new Error(`Timed out waiting for ${runtime}`)
              })
            const task = yield* run()
            const exec = required(fake.execs.filter((e) => e.cmd[0] === binary).at(-1))
            const configPath =
              runtime === 'codex'
                ? `${required(exec.env['CODEX_HOME'])}/config.toml`
                : `${exec.cwd}/${runtime === 'claude-code' ? '.taut/mcp.json' : runtime === 'cursor' ? '.cursor/mcp.json' : 'opencode.json'}`
            const config = required(fake.files.get(configPath))
            expect(config).toContain(connectorUrl)
            expect(config).toContain(secret)
            expect(config).not.toContain(otherSecret)
            expect(config).not.toContain('other.example.com')
            if (runtime === 'codex') {
              expect(config).toContain(`[mcp_servers.${key}.http_headers]`)
              expect(config).toContain(`X-API-Key = "${secret}"`)
            } else {
              const parsed = JSON.parse(config)
              const servers = runtime === 'opencode' ? parsed.mcp : parsed.mcpServers
              expect(Object.keys(servers)).toEqual(['taut', key])
              expect(servers[key]).toMatchObject({
                url: connectorUrl,
                headers: { 'X-API-Key': secret }
              })
            }
            if (runtime === 'claude-code') expect(exec.cmd).toContain(`mcp__${key}__*`)
            if (runtime === 'cursor') {
              expect(exec.cmd).toContain('--approve-mcps')
              const permissions = JSON.parse(
                required(fake.files.get(`${exec.cwd}/.cursor/cli.json`))
              )
              expect(permissions.permissions.allow).toContain(`Mcp(${key}:*)`)
            }
            const reply = yield* messages
              .byId(company.id, task.messageId)
              .pipe(Effect.map(Option.getOrThrow))
            expect(reply.body).toContain('Connector replied with ')
            expect(reply.body).not.toContain(secret)
            const sql = yield* SqlClient.SqlClient
            const events =
              yield* sql`SELECT payload_json FROM events WHERE company_id = ${company.id}`
            expect(JSON.stringify(events)).not.toContain(secret)
            expect(JSON.stringify(events)).not.toContain(otherSecret)

            yield* owner.api.agents.removeConnector({
              path: { agentId: agent.id, connectorId: connector.id }
            })
            // A failed replacement must never spawn an agent using its stale connector file.
            const execCount = fake.execs.filter((e) => e.cmd[0] === binary).length
            unwritableConfig = configPath
            const failed = yield* run(task.threadId, 'failed').pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  unwritableConfig = undefined
                })
              )
            )
            expect(failed.error).toContain('configuration')
            expect(fake.files.get(configPath)).toBe(config)
            expect(fake.execs.filter((e) => e.cmd[0] === binary)).toHaveLength(execCount)

            const next = yield* run(task.threadId)
            expect(next.threadId).toBe(task.threadId)
            const refreshed = required(fake.files.get(configPath))
            expect(refreshed).not.toContain(connectorUrl)
            expect(refreshed).not.toContain(secret)
            expect(refreshed).not.toContain(key)
          })
      )
    }
  })
})
