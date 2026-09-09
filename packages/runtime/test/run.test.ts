import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { claudeCode } from '../src/adapters/claudeCode.js'
import type { AgentEvent } from '../src/adapters/types.js'
import type { ExecOutput, Machine } from '../src/machine/types.js'
import { makeRedactor } from '../src/redact.js'
import { runTask } from '../src/run.js'
import { specFor } from './helpers.js'

/** A machine whose `execStream` replays canned output; records what was written. */
const fakeMachine = (output: ReadonlyArray<ExecOutput>): Machine => {
  const spec = specFor('/data/acme/bruno/home')
  return {
    id: 'fake',
    provider: 'local',
    spec,
    paths: { home: spec.homeDir, hostHome: spec.homeDir },
    status: () => Effect.succeed('running' as const),
    start: () => Effect.void,
    stop: () => Effect.void,
    destroy: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, durationMs: 1 }),
    execStream: () => Stream.fromIterable(output),
    openPty: () => Effect.die('no pty in this fake'),
    openTunnel: () => Effect.die('no tunnel in this fake'),
    signalTasks: () => Effect.succeed(0),
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(new Uint8Array())
  }
}

const assistant = (text: string): ExecOutput => ({
  _tag: 'stdout',
  line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
})

describe('runTask redaction', () => {
  const apiKey = 'sk-ant-api03-TASKSECRET-0001'
  const late = 'vault-secret-value-9999'

  it('uses the caller-owned redactor and add()s the command env secrets to it', async () => {
    const redactor = makeRedactor(['seat-secret-ABCDEF'])
    const stderr: Array<string> = []
    const machine = fakeMachine([
      assistant(`key ${apiKey} seat seat-secret-ABCDEF`),
      { _tag: 'stderr', line: `stderr ${apiKey}` },
      { _tag: 'exit', result: { exitCode: 0, durationMs: 5 } }
    ])
    const command = claudeCode.buildCommand({
      prompt: 'x',
      cwd: '/data/acme/bruno/home/work/tsk_1',
      home: '/data/acme/bruno/home',
      permissionMode: 'plan',
      credential: { kind: 'anthropic.api_key', secret: apiKey }
    })
    const events = await Effect.runPromise(
      Stream.runCollect(
        runTask({
          machine,
          adapter: claudeCode,
          command,
          cwd: '/x',
          redactor,
          onStderr: (l) => stderr.push(l)
        })
      )
    )
    const texts = [...events].filter(
      (e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta'
    )
    expect(texts[0]?.text).toBe('key ••••0001 seat ••••CDEF')
    expect(stderr).toEqual(['stderr ••••0001'])
    // the env secret went *into the caller's* redactor
    expect(redactor.redact(apiKey)).toBe('••••0001')
  })

  it('masks a secret added to the redactor while the stream is running', async () => {
    const redactor = makeRedactor()
    let calls = 0
    const machine = fakeMachine([])
    // Stream is lazy: the first line is produced before add(), the second after.
    machine.execStream = () =>
      Stream.fromIterable([assistant(`before ${late}`), assistant(`after ${late}`)]).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            calls++
          })
        ),
        Stream.map((out) => {
          if (calls === 2) redactor.add(late)
          return out
        }),
        Stream.concat(
          Stream.succeed<ExecOutput>({ _tag: 'exit', result: { exitCode: 0, durationMs: 1 } })
        )
      )
    const events = await Effect.runPromise(
      Stream.runCollect(
        runTask({
          machine,
          adapter: claudeCode,
          command: { cmd: ['claude'], env: {} },
          cwd: '/x',
          redactor
        })
      )
    )
    const texts = [...events].filter(
      (e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta'
    )
    expect(texts.map((t) => t.text)).toEqual([`before ${late}`, 'after ••••9999'])
  })

  it('builds a fresh redactor when none is given (old behaviour)', async () => {
    const machine = fakeMachine([
      assistant(`env ${apiKey}`),
      { _tag: 'exit', result: { exitCode: 0, durationMs: 5 } }
    ])
    const events = await Effect.runPromise(
      Stream.runCollect(
        runTask({
          machine,
          adapter: claudeCode,
          command: { cmd: ['claude'], env: { ANTHROPIC_API_KEY: apiKey } },
          cwd: '/x'
        })
      )
    )
    const text = [...events].find((e) => e.type === 'text_delta')
    expect(text).toEqual({ type: 'text_delta', text: 'env ••••0001' })
  })
})
