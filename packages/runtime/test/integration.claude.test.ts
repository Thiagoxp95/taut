/**
 * Real one-shot `claude -p "reply with exactly: pong"` through LocalProvider +
 * adapter + parser + redactor. Needs the host's own `claude` login:
 *
 *   TAUT_TEST_CLAUDE=1 pnpm --filter @taut/runtime test -- integration
 *
 * `host-login` leaves `CLAUDE_CONFIG_DIR` unset and the test passes the real
 * `HOME` (and relies on `USER` from the allowlist), because Claude Code's macOS
 * keychain entry and `~/.claude.json` are only found under the default config
 * dir and the login user (see docs/CHANGELOG.md).
 */
import { Chunk, Effect, Stream } from 'effect'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { claudeCode } from '../src/adapters/claudeCode.js'
import type { AgentEvent } from '../src/adapters/types.js'
import { makeLocalProvider } from '../src/machine/local.js'
import type { Machine } from '../src/machine/types.js'
import { runTask } from '../src/run.js'
import { onPath, specFor, tempHome } from './helpers.js'

// eslint-disable-next-line turbo/no-undeclared-env-vars
const enabled = process.env['TAUT_TEST_CLAUDE'] === '1' && onPath('claude')

describe.skipIf(!enabled)('claude-code end to end (TAUT_TEST_CLAUDE=1)', () => {
  let cleanup = async () => {}
  let machine: Machine
  beforeAll(async () => {
    const t = await tempHome()
    cleanup = t.cleanup
    machine = await Effect.runPromise(makeLocalProvider().ensure(specFor(t.home)))
  })
  afterAll(() => cleanup())

  it('runs a real one-shot and yields session → text → usage → done', async () => {
    const cwd = join(machine.paths.home, 'work', 'tsk_it')
    await Effect.runPromise(machine.putFile(join(cwd, '.keep'), ''))
    const built = claudeCode.buildCommand({
      prompt: 'reply with exactly: pong',
      cwd,
      home: machine.paths.home,
      permissionMode: 'plan',
      credential: { kind: 'host-login' }
    })
    const stderr: Array<string> = []
    const events: Array<AgentEvent> = Chunk.toArray(
      await Effect.runPromise(
        Stream.runCollect(
          runTask({
            machine,
            adapter: claudeCode,
            command: { ...built, env: { ...built.env, HOME: homedir() } },
            cwd,
            onStderr: (l) => stderr.push(l),
            timeoutMs: 120_000
          })
        )
      )
    )
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('session')
    expect(types).toContain('text_delta')
    expect(types).toContain('usage')
    const done = events.find((e) => e.type === 'done')
    expect(done, `events: ${JSON.stringify(events)}\nstderr: ${stderr.join('\n')}`).toMatchObject({
      ok: true,
      reason: 'success'
    })
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(text.toLowerCase()).toContain('pong')
    expect(types.filter((t) => t === 'done')).toHaveLength(1)
  }, 150_000)
})
