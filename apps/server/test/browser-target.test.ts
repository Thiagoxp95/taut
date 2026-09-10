import { afterEach, expect, it } from 'vitest'
import { Effect, Stream } from 'effect'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Machine } from '@taut/runtime'
import { openBrowserSession } from '../src/services/browserLive.js'
import { startFakeCdp } from './_fakeCdp.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
it('follows the tool-selected target even when a different tab is visible, including reconnect', async () => {
  const cdp = await startFakeCdp()
  const home = mkdtempSync(join(tmpdir(), 'taut-follow-'))
  dirs.push(home)
  mkdirSync(join(home, '.taut/browser'), { recursive: true })
  const select = (id: string) => writeFileSync(join(home, '.taut/browser/active-target'), id)
  cdp.createPage('pizza', 'Pizza', 'https://pizza.example/')
  select('page-1')
  const machine = {
    spec: { agentId: 'agent' },
    paths: { hostHome: home },
    openTunnel: () =>
      Effect.acquireRelease(
        Effect.sync(() => cdp.tunnel()),
        (socket) => Effect.sync(() => socket.destroy())
      )
  } as unknown as Machine
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* openBrowserSession(machine, { port: cdp.port })
          const first = yield* Stream.runHead(session.tabs)
          expect(first).toMatchObject({ value: { activeTabId: 'page-1' } })
          select('pizza')
          const next = yield* Stream.runHead(session.tabs).pipe(Effect.timeout('2 seconds'))
          expect(next).toMatchObject({ value: { activeTabId: 'pizza' } })
          select('page-1')
          const back = yield* Stream.runHead(session.tabs).pipe(Effect.timeout('2 seconds'))
          expect(back).toMatchObject({ value: { activeTabId: 'page-1' } })
        })
      )
    )
  } finally {
    await cdp.close()
  }
})
