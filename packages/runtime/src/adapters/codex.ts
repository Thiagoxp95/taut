/**
 * OpenAI Codex CLI adapter. **Tested only for `detect()`** — `buildCommand` and
 * `parseLine` follow the documented `codex exec --json` JSONL contract
 * (docs/research/agent-orchestration.md, `codex exec --help` 0.151.0) and
 * Sandcastle's `codex()` builder (MIT, see ../../NOTICE) but have not been run
 * against a live account from Taut.
 *
 *   codex exec --json --skip-git-repo-check --color never [-m <model>]
 *              [--sandbox read-only|workspace-write] [-C <cwd>] -
 *   codex exec resume <sid> --json --skip-git-repo-check [-m <model>] -     (resume)
 *
 * Prompt on stdin (`-`). Env: `CODEX_HOME=<home>/.taut/codex`; `openai.api_key`
 * → `CODEX_API_KEY` (+ `OPENAI_API_KEY` for older builds); `openai.oauth` → the
 * secret is written to `$CODEX_HOME/auth.json` via `files`.
 *
 * MCP: Codex has no `--mcp-config` / allow-list flags. Servers (`taut` and any extra
 * such as `browser`) come from `$CODEX_HOME/config.toml` `[mcp_servers.<key>]`, written
 * by the server from `codexConfigToml`, each with `default_tools_approval_mode = "approve"`:
 * `codex exec` runs with approval policy `never`, so any tool that *asks* for approval is
 * refused outright rather than queued.
 * `input.mcp` is therefore ignored here.
 */
import { posix } from 'node:path'

import { TAUT_PATHS } from '../machine/home.js'
import type { Machine } from '../machine/types.js'
import { arr, detectBinary, isRecord, num, opt, parseJsonObject, raw, str } from './shared.js'
import type { AgentEvent, BuildCommandInput, BuiltCommand, RuntimeAdapter } from './types.js'

export const CODEX_BINARY = 'codex'

const changeKind = (kind: unknown): 'create' | 'update' | 'delete' | 'unknown' => {
  switch (kind) {
    case 'add':
    case 'create':
      return 'create'
    case 'update':
    case 'modify':
      return 'update'
    case 'delete':
    case 'remove':
      return 'delete'
    default:
      return 'unknown'
  }
}

export const buildCodexCommand = (input: BuildCommandInput): BuiltCommand => {
  const cmd: Array<string> = [CODEX_BINARY, 'exec']
  if (input.resumeSessionId !== undefined) cmd.push('resume', input.resumeSessionId)
  cmd.push('--json', '--skip-git-repo-check')
  if (input.resumeSessionId === undefined) {
    cmd.push('--color', 'never')
    cmd.push('--sandbox', input.permissionMode === 'plan' ? 'read-only' : 'workspace-write')
    cmd.push('-C', input.cwd)
    if (input.addDirs !== undefined) for (const d of input.addDirs) cmd.push('--add-dir', d)
  }
  if (input.model !== undefined) cmd.push('-m', input.model)
  // D7: Codex's own vocabulary, passed straight through. `max` is not one of its
  // values, so it lands on the highest one that is.
  if (input.reasoningEffort !== undefined) {
    const effort = input.reasoningEffort === 'max' ? 'high' : input.reasoningEffort
    cmd.push('-c', `model_reasoning_effort="${effort}"`)
  }
  cmd.push('-')

  const codexHome = posix.join(input.home, TAUT_PATHS.codexHome)
  const env: Record<string, string> = { CODEX_HOME: codexHome }
  const files: Array<{ path: string; content: string; mode?: number }> = []
  const credential = input.credential
  if (credential !== undefined && credential.kind !== 'host-login') {
    if (credential.kind === 'openai.api_key') {
      env['CODEX_API_KEY'] = credential.secret
      env['OPENAI_API_KEY'] = credential.secret
    } else if (credential.kind === 'openai.oauth') {
      files.push({
        path: posix.join(codexHome, 'auth.json'),
        content: credential.secret,
        mode: 0o600
      })
    }
  }
  return files.length > 0
    ? { cmd, env, stdin: input.prompt, files }
    : { cmd, env, stdin: input.prompt }
}

/**
 * `codex exec --json` events (best effort):
 * `thread.started{thread_id}` → session · `item.started|completed{item}` with item types
 * `agent_message{text}` → text_delta, `reasoning{text|summary}` → thinking, `command_execution{command,aggregated_output,exit_code}`
 * → tool_use/tool_result, `file_change{changes:[{path,kind}]}` → file_change,
 * `mcp_tool_call{server,tool,arguments,result}` → tool_use/tool_result ·
 * `turn.completed{usage}` → usage + context + done · `token_count{info}` → context (carries
 * `model_context_window`) · `turn.failed{error}` / `error{message}` → error.
 */
export const parseCodexLine = (line: string): ReadonlyArray<AgentEvent> => {
  if (line.trim().length === 0) return []
  const json = parseJsonObject(line)
  if (json === null) return [raw(line)]
  const type = str(json['type'])
  switch (type) {
    case 'thread.started': {
      const sessionId = str(json['thread_id'])
      return sessionId === undefined ? [raw(line)] : [{ type: 'session', sessionId }]
    }
    case 'turn.started':
      return []
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = isRecord(json['item']) ? json['item'] : null
      if (item === null) return [raw(line)]
      const id = str(item['id']) ?? ''
      const completed = type === 'item.completed'
      switch (item['type']) {
        case 'agent_message': {
          const text = str(item['text'])
          return completed && text !== undefined
            ? [{ type: 'text_delta', text, snapshot: true }]
            : []
        }
        case 'reasoning': {
          const text = str(item['text']) ?? str(item['summary'])
          return text === undefined || text.length === 0 ? [] : [{ type: 'thinking', text }]
        }
        case 'todo_list':
        case 'web_search':
          return []
        case 'command_execution': {
          if (type === 'item.started') {
            return [
              {
                type: 'tool_use',
                id,
                name: 'command_execution',
                input: { command: item['command'] }
              }
            ]
          }
          if (!completed) return []
          const exit = num(item['exit_code'])
          return [
            {
              type: 'tool_result',
              toolUseId: id,
              content: str(item['aggregated_output']) ?? '',
              isError: exit !== undefined && exit !== 0
            }
          ]
        }
        case 'mcp_tool_call': {
          const name = `${str(item['server']) ?? 'mcp'}.${str(item['tool']) ?? 'tool'}`
          if (type === 'item.started')
            return [{ type: 'tool_use', id, name, input: item['arguments'] }]
          if (!completed) return []
          const result = item['result']
          return [
            {
              type: 'tool_result',
              toolUseId: id,
              content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
              isError: item['status'] === 'failed' || item['error'] !== undefined
            }
          ]
        }
        case 'file_change': {
          if (!completed) return []
          return arr(item['changes']).flatMap((c): Array<AgentEvent> => {
            if (!isRecord(c)) return []
            const path = str(c['path'])
            return path === undefined
              ? []
              : [{ type: 'file_change', path, kind: changeKind(c['kind']) }]
          })
        }
        default:
          return [raw(line)]
      }
    }
    // Codex is the one runtime that states its own denominator, so it is taken
    // over anything the model catalogue would guess (docs/build-plan-context-meter.md D6).
    case 'token_count': {
      const info = isRecord(json['info']) ? json['info'] : undefined
      if (info === undefined) return []
      const last = isRecord(info['last_token_usage']) ? info['last_token_usage'] : undefined
      if (last === undefined) return []
      const inputTokens = num(last['input_tokens']) ?? 0
      const cacheReadTokens = num(last['cached_input_tokens']) ?? 0
      const outputTokens = num(last['output_tokens']) ?? 0
      const usedTokens = num(last['total_tokens']) ?? inputTokens + outputTokens
      if (usedTokens <= 0) return []
      return [
        {
          type: 'context',
          usedTokens,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          ...opt('maxTokens', num(info['model_context_window'])),
          ...opt('model', str(info['model']))
        }
      ]
    }
    case 'turn.completed': {
      const usage = isRecord(json['usage']) ? json['usage'] : undefined
      const events: Array<AgentEvent> = []
      if (usage !== undefined) {
        const inputTokens = num(usage['input_tokens']) ?? 0
        const cacheReadTokens = num(usage['cached_input_tokens'])
        const outputTokens = num(usage['output_tokens']) ?? 0
        events.push({
          type: 'usage',
          inputTokens,
          outputTokens,
          ...opt('cacheReadTokens', cacheReadTokens)
        })
        // A turn's totals are also a reading of the window, and on builds that
        // send no `token_count` line they are the only one. Last sample wins
        // downstream (D2, D4), so a later `token_count` simply supersedes this.
        const usedTokens = inputTokens + outputTokens
        if (usedTokens > 0) {
          events.push({
            type: 'context',
            usedTokens,
            inputTokens,
            outputTokens,
            ...opt('cacheReadTokens', cacheReadTokens)
          })
        }
      }
      events.push({ type: 'done', ok: true, reason: 'turn.completed' })
      return events
    }
    case 'turn.failed': {
      const error = isRecord(json['error']) ? json['error'] : undefined
      const message = str(error?.['message']) ?? 'turn failed'
      return [
        { type: 'error', message },
        { type: 'done', ok: false, reason: 'turn.failed', summary: message }
      ]
    }
    case 'error':
      return [{ type: 'error', message: str(json['message']) ?? line }]
    default:
      return [raw(line)]
  }
}

export const codex: RuntimeAdapter = {
  kind: 'codex',
  binary: CODEX_BINARY,
  contextReported: true,
  compactsAutomatically: true,
  detect: (machine: Machine) => detectBinary(machine, CODEX_BINARY),
  buildCommand: buildCodexCommand,
  parseLine: parseCodexLine,
  resumeArgs: (sessionId) => ['resume', sessionId]
}
