import type { RuntimeKind } from '@taut/contract/domain'
import { Effect } from 'effect'
import { execFile } from 'node:child_process'

/** CLI binary per runtime (docs/agent-model.md §4 table). */
export const RUNTIME_BINARIES: Record<RuntimeKind, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode'
}

export const DETECT_TIMEOUT_MS = 5_000

export interface Detection {
  readonly installed: boolean
  readonly version?: string | undefined
}

const exec = (
  cmd: string,
  args: ReadonlyArray<string>
): Effect.Effect<{ readonly ok: boolean; readonly stdout: string }> =>
  Effect.async((resume) => {
    const child = execFile(
      cmd,
      [...args],
      { timeout: DETECT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resume(Effect.succeed({ ok: error === null, stdout: String(stdout) }))
    )
    return Effect.sync(() => {
      child.kill()
    })
  })

/**
 * Local `detect()`: is the runtime's binary on this host's PATH, and what version. Phase 4
 * moves this onto the agent's machine (`RuntimeAdapter.detect(machine)`); until then the
 * server process is the machine. Never fails — a missing binary is a result, not an error.
 */
export class RuntimeDetector extends Effect.Service<RuntimeDetector>()('RuntimeDetector', {
  sync: () => ({
    detect: (kind: RuntimeKind): Effect.Effect<Detection> =>
      Effect.gen(function* () {
        const binary = RUNTIME_BINARIES[kind]
        const which = yield* exec(process.platform === 'win32' ? 'where' : 'which', [binary])
        if (!which.ok || which.stdout.trim() === '') return { installed: false }
        const version = yield* exec(binary, ['--version'])
        const firstLine = version.stdout.split('\n')[0]?.trim()
        return { installed: true, version: version.ok && firstLine ? firstLine : undefined }
      })
  })
}) {}
