/** Builds `dist/mcp.js` with tsup and drives it over stdio like a runtime would. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'tsup'
import { beforeAll, describe, expect, it } from 'vitest'

import { ToolNames } from '../src/tools.js'

const root = join(import.meta.dirname, '..')
const mcpJs = join(root, 'dist', 'mcp.js')
const cliJs = join(root, 'dist', 'cli.js')

beforeAll(async () => {
  await build({ config: join(root, 'tsup.config.ts'), silent: true })
  expect(existsSync(mcpJs)).toBe(true)
  expect(existsSync(cliJs)).toBe(true)
}, 120_000)

interface Rpc {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: unknown
}

const talk = (
  messages: ReadonlyArray<Record<string, unknown>>,
  expectIds: number
): Promise<Array<Rpc>> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpJs], {
      env: { ...process.env, TAUT_URL: 'http://127.0.0.1:1', TAUT_TOKEN: 'tok' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Array<Rpc> = []
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout; stderr: ${stderr}`))
    }, 20_000)
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line.length > 0) {
          const msg = JSON.parse(line) as Rpc
          if (msg.id !== undefined) out.push(msg)
        }
        nl = buffer.indexOf('\n')
      }
      if (out.length >= expectIds) {
        clearTimeout(timer)
        child.kill()
        resolve(out)
      }
    })
    child.on('exit', (code) => {
      if (out.length < expectIds) {
        clearTimeout(timer)
        reject(new Error(`exited ${code} early; stderr: ${stderr}`))
      }
    })
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`)
  })

describe('bundled dist/mcp.js', () => {
  it('answers initialize and tools/list over stdio', async () => {
    const [init, list] = await talk(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' }
          }
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
      ],
      2
    )
    expect(init?.result?.['serverInfo']).toMatchObject({ name: 'taut' })
    expect(init?.result?.['capabilities']).toMatchObject({ tools: {} })
    const tools = list?.result?.['tools'] as Array<{ name: string }>
    expect(tools.map((t) => t.name)).toContain('taut_ask')
    expect(tools).toHaveLength(ToolNames.length)
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'vault_get',
        'vault_add',
        'vault_update',
        'vault_delete',
        'github_open_pr'
      ])
    )
  }, 60_000)

  it('exits non-zero with a clear message when TAUT_URL is missing', async () => {
    const code = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mcpJs], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('exit', (c) => resolve({ code: c, stderr }))
    })
    expect(code.code).toBe(1)
    expect(code.stderr).toContain('TAUT_URL')
  }, 30_000)

  it('dist/cli.js help runs without a server', async () => {
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [cliJs, 'help'], {
        env: { TAUT_URL: 'http://x', TAUT_TOKEN: 't' }
      })
      let stdout = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.on('exit', (c) => resolve({ code: c, stdout }))
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('taut send')
  }, 30_000)
})
