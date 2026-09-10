/**
 * OpenCode adapter. **Tested only for `detect()`** — the command follows
 * https://opencode.ai/docs/cli/ (`opencode run --format json`,
 * `--session <id>`, `--agent plan|build`, `--model provider/model`) and the parser
 * is best effort over the JSON event stream (docs/research/agent-orchestration.md).
 * Not run against a live account from Taut; `opencode` is not installed on the
 * dev host as of 2026-09-08.
 *
 *   opencode run --format json [--model <provider/model>] [--agent plan]
 *                [--session <id>] <prompt>
 *
 * `plan` → the built-in read-only `plan` agent. Env: `anthropic.api_key` →
 * `ANTHROPIC_API_KEY`, `openai.api_key` → `OPENAI_API_KEY`. OpenCode's session
 * state is SQLite under `$XDG_DATA_HOME`/`~/.local/share/opencode`, i.e. inside the
 * persistent agent home — resume works on the same machine only.
 *
 * MCP: servers (`taut` and any extra such as `browser`) come from `<cwd>/opencode.json`
 * `mcp` map, written by the server from `opencodeJson`; tools surface as
 * `<server>_<tool>` (`browser_browser_navigate`). There is no CLI allow-list, so
 * `input.mcp` is ignored here.
 *
 * File grants: no `--add-dir`. `input.addDirs` is ignored by `buildCommand`; the server
 * merges `opencodePermission(grants)` into `opencode.json` instead (and the grants are
 * listed in `AGENTS.md`, see `../instructions.ts`).
 */
import { posix } from 'node:path'

import type { Machine } from '../machine/types.js'
import {
  credentialEnv,
  detectBinary,
  isRecord,
  num,
  opt,
  parseJsonObject,
  raw,
  str
} from './shared.js'
import type { AgentEvent, BuildCommandInput, BuiltCommand, RuntimeAdapter } from './types.js'

export const OPENCODE_BINARY = 'opencode'

export interface OpencodeFileGrant {
  readonly path: string
  readonly mode: 'ro' | 'rw'
}

export interface OpencodePermission {
  /** Glob → action; paths outside the project dir the agent may enter. */
  readonly external_directory: Readonly<Record<string, 'allow'>>
  /** Glob → action; present only when some grant is read-only. */
  readonly edit?: Readonly<Record<string, 'deny'>>
}

/**
 * `permission` block for `<cwd>/opencode.json` (schema https://opencode.ai/config.json,
 * 2026-09-08: `external_directory` and `edit` accept a glob → `ask|allow|deny` map).
 * Every granted dir is allowed explicitly so it keeps working if `--auto` is ever dropped;
 * read-only grants additionally deny `edit` under that dir — the one runtime where `ro`
 * is enforced rather than merely stated. `undefined` when there are no grants.
 */
export const opencodePermission = (
  grants: ReadonlyArray<OpencodeFileGrant>
): OpencodePermission | undefined => {
  if (grants.length === 0) return undefined
  const globs = (dir: string): ReadonlyArray<string> => [dir, posix.join(dir, '**')]
  const externalDirectory = Object.fromEntries(
    grants.flatMap((g) => globs(g.path).map((glob) => [glob, 'allow' as const]))
  )
  const readOnly = grants.filter((g) => g.mode === 'ro')
  if (readOnly.length === 0) return { external_directory: externalDirectory }
  return {
    external_directory: externalDirectory,
    edit: Object.fromEntries(
      readOnly.flatMap((g) => globs(g.path).map((glob) => [glob, 'deny' as const]))
    )
  }
}

export const buildOpencodeCommand = (input: BuildCommandInput): BuiltCommand => {
  const cmd: Array<string> = [OPENCODE_BINARY, 'run', '--format', 'json']
  if (input.model !== undefined) cmd.push('--model', input.model)
  if (input.permissionMode === 'plan') cmd.push('--agent', 'plan')
  if (input.resumeSessionId !== undefined) cmd.push('--session', input.resumeSessionId)
  cmd.push(input.prompt)
  return {
    cmd,
    env: credentialEnv(
      { 'anthropic.api_key': 'ANTHROPIC_API_KEY', 'openai.api_key': 'OPENAI_API_KEY' },
      input.credential
    )
  }
}

/**
 * Observed shapes: `{type:"text",sessionID,part:{text}}`, `{type:"reasoning",part:{text}}`,
 * `{type:"tool_use",part:{id,tool,state:{status,input,output,error}}}`,
 * `{type:"step_start"}`, `{type:"step_finish",part:{tokens:{input,output,cache:{read,write}},cost}}`,
 * `{type:"error",error:{name,data:{message}}}`.
 */
export const parseOpencodeLine = (line: string): ReadonlyArray<AgentEvent> => {
  if (line.trim().length === 0) return []
  const json = parseJsonObject(line)
  if (json === null) return [raw(line)]
  const part = isRecord(json['part']) ? json['part'] : {}
  const sessionId = str(json['sessionID']) ?? str(part['sessionID'])
  const withSession = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<AgentEvent> =>
    sessionId === undefined ? events : [{ type: 'session', sessionId }, ...events]

  switch (json['type']) {
    case 'text': {
      const text = str(part['text']) ?? str(json['text'])
      return text === undefined || text.length === 0
        ? []
        : withSession([{ type: 'text_delta', text, ...opt('messageId', str(part['messageID'])) }])
    }
    case 'reasoning': {
      const text = str(part['text']) ?? str(json['text'])
      return text === undefined || text.length === 0 ? [] : [{ type: 'thinking', text }]
    }
    case 'tool_use':
    case 'tool': {
      const id = str(part['id']) ?? str(part['callID']) ?? ''
      const name = str(part['tool']) ?? 'tool'
      const state = isRecord(part['state']) ? part['state'] : {}
      const status = str(state['status'])
      if (status === 'completed' || status === 'error') {
        return [
          {
            type: 'tool_result',
            toolUseId: id,
            content: str(state['output']) ?? str(state['error']) ?? '',
            isError: status === 'error'
          }
        ]
      }
      return [{ type: 'tool_use', id, name, input: state['input'] }]
    }
    case 'step_start':
      return withSession([])
    case 'step_finish': {
      const tokens = isRecord(part['tokens']) ? part['tokens'] : undefined
      if (tokens === undefined) return []
      const cache = isRecord(tokens['cache']) ? tokens['cache'] : {}
      const inputTokens = num(tokens['input']) ?? 0
      const outputTokens = num(tokens['output']) ?? 0
      const cacheReadTokens = num(cache['read'])
      const cacheWriteTokens = num(cache['write'])
      const events: Array<AgentEvent> = [
        {
          type: 'usage',
          inputTokens,
          outputTokens,
          ...opt('cacheReadTokens', cacheReadTokens),
          ...opt('cacheWriteTokens', cacheWriteTokens),
          ...opt('costUsd', num(part['cost']))
        }
      ]
      // One step's counters are also one reading of the window (D4). Last one wins.
      const usedTokens =
        inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
      if (usedTokens > 0) {
        events.push({
          type: 'context',
          usedTokens,
          inputTokens,
          outputTokens,
          ...opt('cacheReadTokens', cacheReadTokens),
          ...opt('cacheWriteTokens', cacheWriteTokens)
        })
      }
      return events
    }
    case 'error': {
      const error = isRecord(json['error']) ? json['error'] : {}
      const data = isRecord(error['data']) ? error['data'] : {}
      const message = str(data['message']) ?? str(error['message']) ?? str(error['name']) ?? line
      return [{ type: 'error', message, ...opt('code', str(error['name'])) }]
    }
    default:
      return [raw(line)]
  }
}

export const opencode: RuntimeAdapter = {
  kind: 'opencode',
  binary: OPENCODE_BINARY,
  contextReported: true,
  compactsAutomatically: true,
  detect: (machine: Machine) => detectBinary(machine, OPENCODE_BINARY),
  buildCommand: buildOpencodeCommand,
  parseLine: parseOpencodeLine,
  resumeArgs: (sessionId) => ['--session', sessionId]
}
