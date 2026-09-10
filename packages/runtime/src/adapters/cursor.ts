/**
 * Cursor CLI (`cursor-agent`) adapter. The command follows `cursor-agent --help`
 * and https://cursor.com/docs/cli/headless. A live API-key smoke test using Taut's
 * isolated local environment passed on 2026-09-10 (CLI 2026.09.02-c22c1a3);
 * the parser follows the documented stream-json shapes (docs/research/agent-orchestration.md).
 *
 *   cursor-agent -p --output-format stream-json --trust --workspace <cwd>
 *                [--mode plan] [--force] [--model <m>] [--resume <chatId>]
 *                [--approve-mcps] <prompt>
 *
 * MCP: servers come from `<cwd>/.cursor/mcp.json` (written by the server from
 * `cursorMcpJson`, extra servers included) and tools are pre-approved through
 * `<cwd>/.cursor/cli.json` `permissions.allow` (`cursorCliJsonFor`). `--approve-mcps`
 * (verified in `cursor-agent --help`, 2026-09-08) is added whenever `input.mcp` is set so
 * the headless run does not stall on the server-approval prompt; `mcp.configPath` and
 * `mcp.allowedTools` have no CLI equivalent and are ignored.
 *
 * The prompt is argv (~120 KB cap per Sandcastle's guard). `plan` → `--mode plan`
 * (read-only); `auto-edit` → `--force` so edits apply without prompts. Env:
 * `cursor.api_key` → `CURSOR_API_KEY`. Cursor keeps its state in `~/.cursor`, i.e.
 * inside the persistent agent home. API-key runs use an in-memory credential store:
 * Cursor otherwise persists exchanged tokens to the macOS keychain, which prompts
 * for a missing keychain under the isolated HOME. The vault supplies each run's key.
 *
 * File grants: `cursor-agent --help` (2026.04.30) has no `--add-dir`, and `--force` scopes
 * nothing, so `input.addDirs` is ignored here; the grants reach the agent only through the
 * "## File access" section of `.cursor/rules/taut.mdc` (`../instructions.ts`).
 */
import type { Machine } from '../machine/types.js'
import {
  arr,
  contentText,
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

export const CURSOR_BINARY = 'cursor-agent'

export const buildCursorCommand = (input: BuildCommandInput): BuiltCommand => {
  const cmd: Array<string> = [CURSOR_BINARY, '-p', '--output-format', 'stream-json', '--trust']
  cmd.push('--workspace', input.cwd)
  if (input.permissionMode === 'plan') cmd.push('--mode', 'plan')
  else cmd.push('--force')
  if (input.model !== undefined) cmd.push('--model', input.model)
  if (input.resumeSessionId !== undefined) cmd.push('--resume', input.resumeSessionId)
  if (input.mcp !== undefined) cmd.push('--approve-mcps')
  cmd.push(input.prompt)
  const env = credentialEnv({ 'cursor.api_key': 'CURSOR_API_KEY' }, input.credential)
  // Supported by Cursor's credential-store selector (CLI 2026.09.02-c22c1a3).
  // Keep saved-login discovery intact when the caller does not inject a key.
  if (input.credential?.kind === 'cursor.api_key') env['AGENT_CLI_CREDENTIAL_STORE'] = 'memory'
  return { cmd, env }
}

/**
 * Cursor's stream-json mirrors Claude's: `system/init{session_id}`,
 * `assistant{message.content[]}`, `tool_call{subtype:started|completed,call_id,tool_call}`,
 * `result{subtype,result,duration_ms,session_id}`.
 */
export const parseCursorLine = (line: string): ReadonlyArray<AgentEvent> => {
  if (line.trim().length === 0) return []
  const json = parseJsonObject(line)
  if (json === null) return [raw(line)]
  switch (json['type']) {
    case 'system': {
      if (json['subtype'] !== 'init') return []
      const sessionId = str(json['session_id']) ?? str(json['chat_id'])
      return sessionId === undefined
        ? [raw(line)]
        : [{ type: 'session', sessionId, ...opt('model', str(json['model'])) }]
    }
    case 'assistant': {
      const message = isRecord(json['message']) ? json['message'] : {}
      return arr(message['content']).flatMap((block): Array<AgentEvent> => {
        if (!isRecord(block) || block['type'] !== 'text') return []
        const text = str(block['text'])
        return text === undefined || text.length === 0 ? [] : [{ type: 'text_delta', text }]
      })
    }
    case 'user': {
      const message = isRecord(json['message']) ? json['message'] : {}
      return arr(message['content']).flatMap((block): Array<AgentEvent> =>
        isRecord(block) && block['type'] === 'tool_result'
          ? [
              {
                type: 'tool_result',
                toolUseId: str(block['tool_use_id']) ?? '',
                content: contentText(block['content']),
                isError: block['is_error'] === true
              }
            ]
          : []
      )
    }
    case 'tool_call': {
      const id = str(json['call_id']) ?? str(json['id']) ?? ''
      const call = isRecord(json['tool_call']) ? json['tool_call'] : {}
      const [name, payload] = Object.entries(call)[0] ?? ['tool', undefined]
      if (json['subtype'] === 'started') {
        const args = isRecord(payload) ? payload['args'] : payload
        return [{ type: 'tool_use', id, name, input: args }]
      }
      if (json['subtype'] === 'completed') {
        const result = isRecord(payload) ? payload['result'] : payload
        const success = isRecord(result) && 'success' in result
        return [
          {
            type: 'tool_result',
            toolUseId: id,
            content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
            isError: isRecord(result) && 'error' in result && !success
          }
        ]
      }
      return []
    }
    case 'result': {
      const subtype = str(json['subtype'])
      const ok = subtype === 'success' && json['is_error'] !== true
      return [
        {
          type: 'done',
          ok,
          ...opt('summary', str(json['result'])),
          ...opt('reason', subtype),
          ...opt('sessionId', str(json['session_id'])),
          ...opt('durationMs', num(json['duration_ms']))
        }
      ]
    }
    default:
      return [raw(line)]
  }
}

export const cursor: RuntimeAdapter = {
  kind: 'cursor',
  binary: CURSOR_BINARY,
  // Cursor's stream carries no token counts of any kind, so the meter says that
  // rather than drawing an empty ring (docs/build-plan-context-meter.md D5).
  contextReported: false,
  compactsAutomatically: false,
  detect: (machine: Machine) => detectBinary(machine, CURSOR_BINARY),
  buildCommand: buildCursorCommand,
  parseLine: parseCursorLine,
  resumeArgs: (sessionId) => ['--resume', sessionId]
}
