/**
 * Claude Code adapter — the one MVP runtime (docs/agent-model.md §6).
 *
 * Command (flags verified against `claude 2.1.263 --help` on 2026-09-08 and
 * Sandcastle's `claudeCode()` builder — MIT, see ../../NOTICE):
 *
 *   claude -p --output-format stream-json --verbose
 *          [--resume <sid>] [--model <m>] [--permission-mode default|acceptEdits]
 *          [--mcp-config <path> --strict-mcp-config --allowedTools mcp__taut__*]
 *          [--append-system-prompt-file <path>] [--add-dir <d>...] [--max-budget-usd <n>]
 *
 * The prompt goes on **stdin** by default (argv is capped at 128 KB; agent-model
 * §6) — pass `promptVia: "argv"` to place it right after `-p` instead. Never
 * pass `--bare` (it ignores `CLAUDE_CODE_OAUTH_TOKEN`) and never run as root with
 * `--dangerously-skip-permissions` (refused) — docs/research/agent-sandboxes.md §5.
 * `--bare` is scheduled to become the default for `-p`; see `CLAUDE_CODE_VERSION`.
 *
 * Env: `CLAUDE_CONFIG_DIR=<home>/.taut/claude` so the OAuth account, trust state
 * and `projects/<cwd>/<sid>.jsonl` sessions live in the persistent home; one of
 * `CLAUDE_CODE_OAUTH_TOKEN` (`claude.oauth` verbatim, `claude.login` via its
 * `claudeAiOauth.accessToken`) / `ANTHROPIC_API_KEY`
 * (`anthropic.api_key`). With `host-login` neither var is set and
 * `CLAUDE_CONFIG_DIR` is left alone — the caller must then also pass the real
 * `HOME` so `~/.claude.json` and the keychain entry are found (dev only).
 */
import type { ReasoningEffort } from '@taut/contract/domain'
import { posix } from 'node:path'

import { TAUT_PATHS } from '../machine/home.js'
import type { Machine } from '../machine/types.js'
import {
  arr,
  contentText,
  detectBinary,
  isRecord,
  num,
  opt,
  parseJsonObject,
  raw,
  str
} from './shared.js'
import type { AgentEvent, BuildCommandInput, BuiltCommand, RuntimeAdapter } from './types.js'

export const CLAUDE_BINARY = 'claude'

/**
 * Exact version pinned in the agent image (`docker/agent.Dockerfile`), the way
 * `BROWSER_MCP_VERSION` pins Playwright.
 *
 * Not cosmetic. Anthropic documents that `--bare` "will become the default for
 * `-p` in a future release", and that in bare mode Claude Code "never reads OAuth
 * credentials or the system keychain" — auth becomes strictly `ANTHROPIC_API_KEY`
 * or an `apiKeyHelper`. On the release that flips that default, every seat this
 * adapter authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (`claude.oauth`,
 * `claude.login`) fails with `authentication_failed`; only `anthropic.api_key`
 * survives. There is no `--no-bare` (checked against 2.1.266), so the pin is the
 * only defence. `DISABLE_AUTOUPDATER=1` below keeps a *running* box from
 * upgrading into it; the image build is the exposure.
 *
 * Source: https://code.claude.com/docs/en/headless §"Start faster with bare mode".
 */
export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code'
export const CLAUDE_CODE_VERSION = '2.1.266'
export const DEFAULT_MCP_ALLOWED_TOOLS = ['mcp__taut__*'] as const

/** Tools whose `input.file_path` / `notebook_path` marks a file change. */
const FILE_TOOLS: Readonly<Record<string, 'create' | 'update'>> = {
  Write: 'create',
  Edit: 'update',
  MultiEdit: 'update',
  NotebookEdit: 'update'
}

export interface ClaudeCodeOptions {
  /** Where the prompt travels. Default `stdin`. */
  readonly promptVia?: 'stdin' | 'argv'
}

export interface ClaudeCodeBuildInput extends BuildCommandInput {
  readonly promptVia?: 'stdin' | 'argv'
}

/**
 * Taut `plan` = read-only. Claude Code's own `plan` mode refuses *every* tool call, MCP included
 * (`Cannot call mcp__taut__… while in plan mode`, 2.1.263), so it is mapped to `default` plus an
 * explicit read-only allow-list; in headless mode anything outside `--allowedTools` is denied.
 */
const permissionFlag = (mode: BuildCommandInput['permissionMode']): string =>
  mode === 'plan' ? 'default' : 'acceptEdits'

/** Built-in tools a read-only (`plan`) agent may still use. */
export const PLAN_MODE_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep'] as const

/**
 * The bearer token inside a `claude.login` record.
 *
 * A `claude login` credential is the whole `{"claudeAiOauth":{…}}` file, not a
 * line: the seat stores it whole because that is the only shape carrying the
 * refresh token, and the runtime only ever wants `accessToken`. The server
 * renews that token before spawn, so what arrives here is current; an
 * unreadable record yields nothing rather than a garbage `Bearer {`.
 */
export const accessTokenOf = (secret: string): string | undefined => {
  const record = parseJsonObject(secret)
  if (record === null) return undefined
  const oauth = isRecord(record['claudeAiOauth']) ? record['claudeAiOauth'] : record
  const token = str(oauth['accessToken'])
  return token === undefined || token === '' ? undefined : token
}

/**
 * `reasoningEffort` → `MAX_THINKING_TOKENS`, the only thinking control headless
 * `claude` reads (docs/build-plan-run-overrides.md D7).
 *
 * The numbers are the budgets the interactive CLI's own think levels use, so
 * "high" here buys what "think harder" buys there. `minimal` is not offered for
 * this runtime — the smallest budget worth spending is already thousands of
 * tokens — but it is mapped anyway rather than crashing on a value an older
 * client sends.
 */
const THINKING_TOKENS: Record<ReasoningEffort, number> = {
  minimal: 4_000,
  low: 4_000,
  medium: 10_000,
  high: 31_999,
  max: 63_999
}

export const makeClaudeCodeAdapter = (
  options: ClaudeCodeOptions = {}
): RuntimeAdapter & {
  buildCommand(input: ClaudeCodeBuildInput): BuiltCommand
} => {
  const buildCommand = (input: ClaudeCodeBuildInput): BuiltCommand => {
    const promptVia = input.promptVia ?? options.promptVia ?? 'stdin'
    const cmd: Array<string> = [CLAUDE_BINARY, '-p']
    if (promptVia === 'argv') cmd.push(input.prompt)
    cmd.push('--output-format', 'stream-json', '--verbose')
    if (input.resumeSessionId !== undefined) cmd.push(...resumeArgs(input.resumeSessionId))
    if (input.model !== undefined) cmd.push('--model', input.model)
    cmd.push('--permission-mode', permissionFlag(input.permissionMode))
    if (input.mcp !== undefined) {
      cmd.push('--mcp-config', input.mcp.configPath, '--strict-mcp-config')
      cmd.push(
        '--allowedTools',
        ...(input.mcp.allowedTools ?? DEFAULT_MCP_ALLOWED_TOOLS),
        ...(input.permissionMode === 'plan' ? PLAN_MODE_BUILTIN_TOOLS : [])
      )
    }
    if (input.systemPromptFile !== undefined) {
      cmd.push('--append-system-prompt-file', input.systemPromptFile)
    }
    if (input.addDirs !== undefined && input.addDirs.length > 0) {
      cmd.push('--add-dir', ...input.addDirs)
    }
    if (input.maxBudgetUsd !== undefined) cmd.push('--max-budget-usd', String(input.maxBudgetUsd))

    const env: Record<string, string> = {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(input.reasoningEffort === undefined
        ? {}
        : { MAX_THINKING_TOKENS: String(THINKING_TOKENS[input.reasoningEffort]) })
    }
    const credential = input.credential
    if (credential === undefined || credential.kind !== 'host-login') {
      env['CLAUDE_CONFIG_DIR'] = posix.join(input.home, TAUT_PATHS.claudeConfig)
    }
    if (credential !== undefined && credential.kind !== 'host-login') {
      if (credential.kind === 'claude.oauth') env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.secret
      else if (credential.kind === 'claude.login') {
        const token = accessTokenOf(credential.secret)
        if (token !== undefined) env['CLAUDE_CODE_OAUTH_TOKEN'] = token
      } else if (credential.kind === 'anthropic.api_key') {
        env['ANTHROPIC_API_KEY'] = credential.secret
      }
    }

    return promptVia === 'stdin' ? { cmd, env, stdin: input.prompt } : { cmd, env }
  }

  const resumeArgs = (sessionId: string): ReadonlyArray<string> => ['--resume', sessionId]

  return {
    kind: 'claude-code',
    binary: CLAUDE_BINARY,
    contextReported: true,
    compactsAutomatically: true,
    detect: (machine: Machine) => detectBinary(machine, CLAUDE_BINARY),
    buildCommand,
    parseLine: parseClaudeLine,
    resumeArgs
  }
}

/**
 * The window occupancy of one assistant message
 * (docs/build-plan-context-meter.md D3).
 *
 * `input_tokens` alone is the wrong number and is wrong by a lot: with prompt
 * caching on — which is always, headless — it counts only the few tokens that
 * were not served from cache, so a 90k-token conversation reports as 3. The
 * prompt that was actually sent is the three input counters added together, and
 * adding the output makes it what the *next* call will carry.
 */
const claudeContextEvent = (
  message: Record<string, unknown>
): Extract<AgentEvent, { type: 'context' }> | undefined => {
  const usage = isRecord(message['usage']) ? message['usage'] : undefined
  if (usage === undefined) return undefined
  const inputTokens = num(usage['input_tokens']) ?? 0
  const cacheReadTokens = num(usage['cache_read_input_tokens']) ?? 0
  const cacheWriteTokens = num(usage['cache_creation_input_tokens']) ?? 0
  const outputTokens = num(usage['output_tokens']) ?? 0
  const usedTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  if (usedTokens <= 0) return undefined
  return {
    type: 'context',
    usedTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    ...opt('model', str(message['model']))
  }
}

/**
 * stream-json (`--verbose`) line shapes, captured from claude 2.1.263:
 *
 * - `{"type":"system","subtype":"init","session_id","model","tools":[…]}` → `session`
 * - `{"type":"system","subtype":"hook_started"|"hook_response",…}` → ignored
 * - `{"type":"assistant","message":{"content":[{type:text}|{type:tool_use}]},"error"?}` →
 *   `text_delta` / `thinking` / `tool_use` (+ `file_change` for Write/Edit/…) + `context` from
 *   `message.usage`; `error` when `error` is set
 *   (e.g. `"authentication_failed"` with a synthetic "Not logged in" text)
 * - `{"type":"user","message":{"content":[{type:tool_result,tool_use_id,content,is_error}]}}` → `tool_result`
 * - `{"type":"result","subtype":"success"|"error_*","is_error","result","total_cost_usd","usage",
 *    "num_turns","duration_ms","session_id"}` → `usage` + `done`. Note `is_error: true` can come
 *   with `subtype: "success"` (auth failure) — `ok` uses `is_error`.
 * - `{"type":"rate_limit_event"}` / `{"type":"stream_event"}` → ignored
 */
export const parseClaudeLine = (line: string): ReadonlyArray<AgentEvent> => {
  if (line.trim().length === 0) return []
  const json = parseJsonObject(line)
  if (json === null) return [raw(line)]

  switch (json['type']) {
    case 'system': {
      // SDKStatusMessage / SDKCompactBoundaryMessage in the stream-json protocol.
      if (json['subtype'] === 'compact_boundary') {
        return [{ type: 'compaction', compacting: false }]
      }
      if (json['subtype'] === 'status') {
        const status = json['status']
        return status === 'compacting' || status === null
          ? [{ type: 'compaction', compacting: status === 'compacting' }]
          : []
      }
      if (json['subtype'] !== 'init') return []
      const sessionId = str(json['session_id'])
      if (sessionId === undefined) return [raw(line)]
      const model = str(json['model'])
      return [
        model === undefined ? { type: 'session', sessionId } : { type: 'session', sessionId, model }
      ]
    }

    case 'assistant': {
      const events: Array<AgentEvent> = []
      const message = isRecord(json['message']) ? json['message'] : {}
      const blocks = arr(message['content'])
      const error = str(json['error'])
      if (error !== undefined) {
        const text = blocks
          .map((b) => (isRecord(b) ? str(b['text']) : undefined))
          .find((t): t is string => t !== undefined)
        events.push({ type: 'error', message: text ?? error, code: error })
        return events
      }
      // Every assistant message states the size of the prompt that produced it,
      // which is the only true reading of the window in this stream (D3).
      const context = claudeContextEvent(message)
      if (context !== undefined) events.push(context)
      for (const block of blocks) {
        if (!isRecord(block)) continue
        if (block['type'] === 'text') {
          const text = str(block['text'])
          if (text !== undefined && text.length > 0) events.push({ type: 'text_delta', text })
        } else if (block['type'] === 'thinking') {
          const text = str(block['thinking']) ?? str(block['text'])
          if (text !== undefined && text.length > 0) events.push({ type: 'thinking', text })
        } else if (block['type'] === 'tool_use') {
          const id = str(block['id']) ?? ''
          const name = str(block['name']) ?? ''
          const input = block['input']
          events.push({ type: 'tool_use', id, name, input })
          const kind = FILE_TOOLS[name]
          if (kind !== undefined && isRecord(input)) {
            const path = str(input['file_path']) ?? str(input['notebook_path'])
            if (path !== undefined) events.push({ type: 'file_change', path, kind })
          }
        }
      }
      return events
    }

    case 'user': {
      const events: Array<AgentEvent> = []
      const message = isRecord(json['message']) ? json['message'] : {}
      for (const block of arr(message['content'])) {
        if (!isRecord(block) || block['type'] !== 'tool_result') continue
        events.push({
          type: 'tool_result',
          toolUseId: str(block['tool_use_id']) ?? '',
          content: contentText(block['content']),
          isError: block['is_error'] === true
        })
      }
      return events
    }

    case 'result': {
      const events: Array<AgentEvent> = []
      const usage = isRecord(json['usage']) ? json['usage'] : undefined
      const costUsd = num(json['total_cost_usd'])
      if (usage !== undefined) {
        events.push({
          type: 'usage',
          inputTokens: num(usage['input_tokens']) ?? 0,
          outputTokens: num(usage['output_tokens']) ?? 0,
          ...opt('cacheReadTokens', num(usage['cache_read_input_tokens'])),
          ...opt('cacheWriteTokens', num(usage['cache_creation_input_tokens'])),
          ...opt('costUsd', costUsd)
        })
      }
      const subtype = str(json['subtype'])
      const isError = json['is_error'] === true || (subtype !== undefined && subtype !== 'success')
      const terminal = str(json['terminal_reason'])
      const reason =
        isError && terminal !== undefined && terminal !== 'completed' ? terminal : subtype
      events.push({
        type: 'done',
        ok: !isError,
        ...opt('summary', str(json['result'])),
        ...opt('reason', reason),
        ...opt('sessionId', str(json['session_id'])),
        ...opt('numTurns', num(json['num_turns'])),
        ...opt('durationMs', num(json['duration_ms'])),
        ...opt('costUsd', costUsd)
      })
      return events
    }

    case 'rate_limit_event':
    case 'stream_event':
    case 'prompt_suggestion':
      return []

    default:
      return [raw(line)]
  }
}

/** Default instance. */
export const claudeCode = makeClaudeCodeAdapter()
