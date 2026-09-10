import { afterEach, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserMcpCliPath, ensureLocalBrowserDaemon } from '../src/browser.js'

const { chromium } = createRequire(browserMcpCliPath())('playwright')
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

it.skipIf(!existsSync(chromium.executablePath()))(
  'starts one shared browser on first use with a long agent TMPDIR',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'taut-daemon-test-'))
    dirs.push(home)
    const longTmp = join(home, 'mobile-store-manager-with-a-long-name', '.taut/home/tmp')
    mkdirSync(longTmp, { recursive: true })
    vi.stubEnv('TMPDIR', longTmp)
    const launch = () =>
      Effect.runPromise(
        ensureLocalBrowserDaemon({
          agentId: 'test-agent',
          homeDir: home,
          executable: chromium.executablePath()
        })
      )
    const results = await Promise.allSettled([launch(), launch()])
    const ports = new Set(
      results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.port] : []))
    )
    try {
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(ports.size).toBe(1)
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${[...ports][0]}`)
      const page = browser.contexts()[0].pages()[0]
      await page.goto('data:text/html,<title>First launch</title>Ready')
      expect(await page.title()).toBe('First launch')
    } finally {
      for (const port of ports) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        const session = await browser.newBrowserCDPSession()
        await session.send('Browser.close').catch(() => {})
      }
    }
  },
  30000
)

it('reports a dead launcher promptly so a failed start can be retried', async () => {
  const home = mkdtempSync(join(tmpdir(), 'taut-daemon-test-'))
  dirs.push(home)
  const start = Date.now()
  const result = await Effect.runPromise(
    Effect.either(
      ensureLocalBrowserDaemon({
        agentId: 'test-agent',
        homeDir: home,
        executable: '/usr/bin/false'
      })
    )
  )
  expect(result._tag).toBe('Left')
  expect(Date.now() - start).toBeLessThan(3000)
}, 25000)
