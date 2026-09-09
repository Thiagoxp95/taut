/** Helpers shared by the four adapters. */
import { Effect } from 'effect'

import type { ExecFailed, Machine } from '../machine/types.js'
import type { AgentEvent, DetectResult } from './types.js'

export type Json = Record<string, unknown>

export const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `JSON.parse` that yields `null` for anything that is not a JSON object. */
export const parseJsonObject = (line: string): Json | null => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
export const arr = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/** Render tool-result content (string or content-block array) as plain text. */
export const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) ? (str(block['text']) ?? '') : String(block)))
      .filter((s) => s.length > 0)
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

export const raw = (line: string): AgentEvent => ({ type: 'raw', line })

/** Runs `<binary> --version` on the machine; missing binary → `installed: false`. */
export const detectBinary = (
  machine: Machine,
  binary: string,
  versionArgs: ReadonlyArray<string> = ['--version']
): Effect.Effect<DetectResult, ExecFailed> =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const result = yield* machine.exec({
      cmd: [binary, ...versionArgs],
      onLine: (l) => out.push(l),
      onStderr: (l) => err.push(l),
      timeoutMs: 20_000
    })
    const text = [...out, ...err].join('\n')
    if (result.exitCode !== 0) {
      return {
        installed: false,
        error: `${binary} exited ${result.exitCode}${text ? `: ${text.slice(0, 200)}` : ''}`
      }
    }
    const version = /\d+\.\d+(?:\.\d+)?[\w.+-]*/.exec(text)?.[0]
    return version === undefined ? { installed: true } : { installed: true, version }
  }).pipe(
    Effect.catchTag('BinaryMissing', (e) =>
      Effect.succeed<DetectResult>({ installed: false, error: e.message })
    )
  )

/** `plan` → read-only; `auto-edit` → edits allowed, commands still gated by the runtime. */
export const isReadOnly = (mode: 'plan' | 'auto-edit'): boolean => mode === 'plan'

export const credentialEnv = (
  mapping: Readonly<Record<string, string>>,
  credential: { readonly kind: string; readonly secret?: string } | undefined
): Record<string, string> => {
  if (credential === undefined || credential.kind === 'host-login') return {}
  const name = mapping[credential.kind]
  if (name === undefined || credential.secret === undefined) return {}
  return { [name]: credential.secret }
}

/** `{ [key]: value }` when defined, `{}` otherwise — for optional Schema fields under exactOptionalPropertyTypes-style code. */
export const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V })
