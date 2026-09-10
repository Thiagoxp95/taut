import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import { Effect, Exit, Scope, Stream } from 'effect'
import type { Machine } from '@taut/runtime'
import { openBrowserSession } from '../src/services/browserLive.js'
import { createServer as createHttpServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  browserMcpBridgeSource,
  browserMcpCliPath,
  browserMcpSpec,
  BROWSER_PATHS
} from '@taut/runtime'

const { chromium } = createRequire(browserMcpCliPath())('playwright')

it.skipIf(!existsSync(chromium.executablePath()))(
  'reports the exact MCP tab across selection, duplicate URLs, screenshots and closure',
  async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const port = address.port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const home = mkdtempSync(join(tmpdir(), 'taut-mcp-follow-'))
    mkdirSync(join(home, '.taut/browser/out'), { recursive: true })
    writeFileSync(join(home, BROWSER_PATHS.bridge), browserMcpBridgeSource)
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`]
    })
    const endpoint = `http://127.0.0.1:${port}`
    // Use the default context, just as Taut's persistent Chromium daemon does.
    const remote = await chromium.connectOverCDP(endpoint)
    const context = remote.contexts()[0]
    const first = await context.newPage()
    const second = await context.newPage()
    await first.evaluate("document.title = 'First'")
    await second.evaluate("document.title = 'Second'")
    const target = async (page: typeof first) => {
      const session = await context.newCDPSession(page)
      try {
        return (await session.send('Target.getTargetInfo')).targetInfo.targetId
      } finally {
        void session.detach().catch(() => {})
      }
    }
    const ids = [await target(first), await target(second)]
    const spec = browserMcpSpec({
      provider: 'local',
      homeDir: home,
      cdpEndpoint: endpoint,
      follow: true
    })
    const child = spawn(spec.command, [...spec.args], {
      env: { ...process.env, ...spec.env },
      stdio: 'pipe'
    })
    const lines = createInterface({ input: child.stdout })
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    type Reply = {
      error?: unknown
      result?: { isError?: boolean; content: Array<{ type: string; text?: string }> }
    }
    const pending = new Map<number, (value: Reply) => void>()
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    let id = 0
    const request = (method: string, params: object) =>
      new Promise<Reply>((resolve, reject) => {
        const key = ++id
        const timeout = setTimeout(() => reject(new Error('MCP timeout: ' + errors)), 8000)
        pending.set(key, (value) => {
          clearTimeout(timeout)
          resolve(value)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
      })
    const scope = Effect.runSync(Scope.make())
    let viewedTarget: string | null = null
    let frameCount = 0
    const call = async (name: string, args: object) => {
      const response = await request('tools/call', { name, arguments: args })
      expect(response.error, errors).toBeUndefined()
      expect(response.result?.isError, JSON.stringify(response.result)).not.toBe(true)
      const targetId = readFileSync(join(home, BROWSER_PATHS.activeTarget), 'utf8')
      await expect.poll(() => viewedTarget).toBe(targetId)
      return targetId
    }
    try {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      })
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      )
      const listing = await request('tools/call', {
        name: 'browser_tabs',
        arguments: { action: 'list' }
      })
      const machine = {
        spec: { agentId: 'test-agent' },
        paths: { hostHome: home },
        openTunnel: () =>
          Effect.acquireRelease(
            Effect.sync(() => connect(port, '127.0.0.1')),
            (socket) => Effect.sync(() => socket.destroy())
          )
      } as unknown as Machine
      const live = await Effect.runPromise(
        openBrowserSession(machine, { port }).pipe(Scope.extend(scope))
      )
      await Effect.runPromise(
        Stream.runForEach(live.tabs, (frame) =>
          Effect.sync(() => {
            viewedTarget = frame.activeTabId
          })
        ).pipe(Effect.forkIn(scope))
      )
      await Effect.runPromise(
        Stream.runForEach(live.frames, () =>
          Effect.sync(() => {
            frameCount++
          })
        ).pipe(Effect.forkIn(scope))
      )
      const listingText = listing
        .result!.content.map((item: { text?: string }) => item.text ?? '')
        .join('\n')
      const firstIndex = Number(listingText.match(/- (\d+):[^\n]*?\[First\]/)?.[1])
      const secondIndex = Number(listingText.match(/- (\d+):[^\n]*?\[Second\]/)?.[1])
      expect(Number.isFinite(firstIndex), listingText).toBe(true)
      expect(Number.isFinite(secondIndex), listingText).toBe(true)
      expect(await call('browser_tabs', { action: 'select', index: firstIndex })).toBe(ids[0])
      expect(await call('browser_tabs', { action: 'select', index: secondIndex })).toBe(ids[1])
      // Visibility and URL cannot distinguish these tabs: both are about:blank.
      expect(await call('browser_tabs', { action: 'select', index: firstIndex })).toBe(ids[0])
      await Effect.runPromise(live.resize({ width: 540, height: 1100 }))
      expect(await first.evaluate('[window.innerWidth, window.innerHeight]')).toEqual([540, 1100])
      expect(await call('browser_tabs', { action: 'select', index: secondIndex })).toBe(ids[1])
      await expect
        .poll(() => second.evaluate('[window.innerWidth, window.innerHeight]'))
        .toEqual([540, 1100])
      await Effect.runPromise(live.resize({ width: 780, height: 950 }))
      expect(await second.evaluate('[window.innerWidth, window.innerHeight]')).toEqual([780, 950])
      expect(await call('browser_tabs', { action: 'select', index: firstIndex })).toBe(ids[0])
      expect(await call('browser_take_screenshot', { type: 'png' })).toBe(ids[0])
      await expect.poll(() => frameCount).toBeGreaterThan(0)
      expect(await call('browser_tabs', { action: 'close', index: firstIndex })).toBe(ids[1])
      let finishResponse = () => {}
      let notifyRequest = () => {}
      const requested = new Promise<void>((resolve) => {
        notifyRequest = resolve
      })
      const slow = createHttpServer((_request, response) => {
        finishResponse = () => {
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end('<title>Loaded</title>')
        }
        notifyRequest()
      })
      await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
      const slowAddress = slow.address()
      if (!slowAddress || typeof slowAddress === 'string') throw new Error('No HTTP port')
      const opened = context.waitForEvent('page')
      const navigating = call('browser_tabs', {
        action: 'new',
        url: `http://127.0.0.1:${slowAddress.port}/`
      })
      try {
        const page = await opened
        const newId = await target(page)
        await requested
        // The user can follow navigation while the tool is still waiting for a response.
        await expect
          .poll(() => readFileSync(join(home, BROWSER_PATHS.activeTarget), 'utf8'), {
            timeout: 1500
          })
          .toBe(newId)
        await expect.poll(() => viewedTarget, { timeout: 1500 }).toBe(newId)
      } finally {
        finishResponse()
        await navigating
        await new Promise<void>((resolve) => slow.close(() => resolve()))
      }
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      child.kill()
      lines.close()
      await browser.close()
      rmSync(home, { recursive: true, force: true })
    }
  },
  20000
)
