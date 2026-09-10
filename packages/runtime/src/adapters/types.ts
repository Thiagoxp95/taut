/**
 * Runtime adapters (docs/agent-model.md §6). An adapter knows one CLI: it
 * produces `{ cmd, env, stdin }` for `Machine.exec` and turns the NDJSON lines
 * the CLI prints into `AgentEvent`s. It never spawns anything itself.
 *
 * Command builders and parsers follow Sandcastle's `AgentProvider.ts` (MIT,
 * see ../../NOTICE).
 */
import type {
  CredentialKind,
  PermissionMode,
  ReasoningEffort,
  RuntimeKind
} from '@taut/contract/domain'
import type { Effect } from 'effect'
import { Schema } from 'effect'

import type { ExecFailed, Machine } from '../machine/types.js'

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const TextDelta = Schema.Struct({
  type: Schema.Literal('text_delta'),
  text: Schema.String,
  /** A complete assistant message, replacing the previous candidate rather than appending. */
  snapshot: Schema.optional(Schema.Boolean),
  /** Groups multipart messages on runtimes that expose message boundaries. */
  messageId: Schema.optional(Schema.String)
})
/**
 * The model's own reasoning, as far as the CLI exposes it. Never part of the
 * reply: it is the running commentary a reader watches instead of a spinner
 * (docs/build-plan-activity.md D1), and it is dropped the moment the run ends.
 *
 * | runtime     | parsed from                                  |
 * | ----------- | -------------------------------------------- |
 * | claude-code | `assistant` content block `{type:"thinking"}` |
 * | codex       | `item.*` item `{type:"reasoning"}`            |
 * | opencode    | part `{type:"reasoning"}`                     |
 * | cursor      | — (says nothing about reasoning)              |
 */
const Thinking = Schema.Struct({ type: Schema.Literal('thinking'), text: Schema.String })
const ToolUse = Schema.Struct({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
})
const ToolResult = Schema.Struct({
  type: Schema.Literal('tool_result'),
  toolUseId: Schema.String,
  content: Schema.String,
  isError: Schema.Boolean
})
export const FileChangeKind = Schema.Literal('create', 'update', 'delete', 'unknown')
const FileChange = Schema.Struct({
  type: Schema.Literal('file_change'),
  path: Schema.String,
  kind: FileChangeKind
})
const Session = Schema.Struct({
  type: Schema.Literal('session'),
  sessionId: Schema.String,
  model: Schema.optional(Schema.String)
})
/**
 * What the run cost. A running total over every turn, which is what a bill is
 * made of — and which is emphatically **not** how full the context window is
 * (docs/build-plan-context-meter.md D1). A cached prompt is re-read and
 * re-billed on every turn while occupying the window exactly once, so these
 * numbers outgrow the window by an order of magnitude on a long run.
 */
const Usage = Schema.Struct({
  type: Schema.Literal('usage'),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  costUsd: Schema.optional(Schema.Number)
})
/**
 * How full the window was at one instant (docs/build-plan-context-meter.md D1).
 * A sample, never a total: the reader keeps the last one and discards the rest
 * (D2). Each runtime samples from a different line, because each protocol is
 * shaped differently:
 *
 * | runtime     | sampled from      | notes                                            |
 * | ----------- | ----------------- | ------------------------------------------------ |
 * | claude-code | `assistant`       | `message.usage` is the prompt of that very call   |
 * | codex       | `turn.completed`  | `model_context_window` arrives on `token_count`   |
 * | opencode    | `step_finish`     | per step, same last-sample-wins rule              |
 * | cursor      | —                 | reports nothing; `contextReported` is false (D5)  |
 */
const Context = Schema.Struct({
  type: Schema.Literal('context'),
  /** Tokens resident in the window at this instant. */
  usedTokens: Schema.Number,
  /** Only when the runtime states it (codex). Otherwise resolved server-side (D6). */
  maxTokens: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  inputTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number)
})
const Done = Schema.Struct({
  type: Schema.Literal('done'),
  ok: Schema.Boolean,
  /** The CLI's final text (`result` for claude/cursor, last agent message for codex). */
  summary: Schema.optional(Schema.String),
  /** Runtime-specific terminal reason (`success`, `error_max_turns`, `api_error`, `exit 1`…). */
  reason: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  numTurns: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  costUsd: Schema.optional(Schema.Number)
})
const ErrorEvent = Schema.Struct({
  type: Schema.Literal('error'),
  message: Schema.String,
  code: Schema.optional(Schema.String)
})
const Raw = Schema.Struct({ type: Schema.Literal('raw'), line: Schema.String })
const Compaction = Schema.Struct({
  type: Schema.Literal('compaction'),
  compacting: Schema.Boolean
})

export const AgentEvent = Schema.Union(
  TextDelta,
  Thinking,
  ToolUse,
  ToolResult,
  FileChange,
  Session,
  Usage,
  Context,
  Compaction,
  Done,
  ErrorEvent,
  Raw
)
export type AgentEvent = typeof AgentEvent.Type
export type AgentEventType = AgentEvent['type']
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface DetectResult {
  readonly installed: boolean
  readonly version?: string
  /** Why detection failed when `installed` is false (missing binary, exit code, stderr). */
  readonly error?: string
}

/**
 * What `vault.resolveForSpawn` hands the adapter. `host-login` means "no
 * credential; use whatever the executing user is logged in as" — dev only, for
 * the `local` provider with the operator's own `claude` login.
 */
export type RuntimeCredential =
  { readonly kind: CredentialKind; readonly secret: string } | { readonly kind: 'host-login' }

/**
 * MCP wiring. Only claude-code takes the config path and allow-list on the command
 * line; the others read config files the server writes with `@taut/taut-mcp` `inject.ts`
 * (which also carries any extra servers such as `browser`):
 *
 * | runtime     | servers                                   | tool approval                              |
 * | ----------- | ----------------------------------------- | ------------------------------------------ |
 * | claude-code | `--mcp-config <configPath> --strict-mcp-config` | `--allowedTools <allowedTools…>`     |
 * | codex       | `$CODEX_HOME/config.toml` `[mcp_servers.*]` | per server `default_tools_approval_mode = "approve"` — `allowedTools` unused |
 * | cursor      | `<cwd>/.cursor/mcp.json`                  | `<cwd>/.cursor/cli.json` `permissions.allow: ["Mcp(<key>:*)"]` + `--approve-mcps` (added when `mcp` is set) — `allowedTools` unused |
 * | opencode    | `<cwd>/opencode.json` `mcp` map           | no CLI allow-list; `allowedTools` unused   |
 */
export interface McpOptions {
  /** Machine-visible path of the MCP config JSON (claude-code only; ignored elsewhere). */
  readonly configPath: string
  /**
   * Tool allow-list; defaults to `["mcp__taut__*"]` on claude-code. Pass
   * `["mcp__taut__*", "mcp__browser__*"]` when the agent has browser access.
   */
  readonly allowedTools?: ReadonlyArray<string>
}

export interface BuildCommandInput {
  readonly prompt: string
  /** Machine-visible task work dir (`<home>/work/<taskId>`). */
  readonly cwd: string
  /** Machine-visible agent home. */
  readonly home: string
  readonly permissionMode: PermissionMode
  readonly model?: string
  /**
   * How hard the model should think (docs/build-plan-run-overrides.md D7).
   * Each adapter maps it to its own CLI; `cursor` and `opencode` have nothing
   * to map it to and drop it:
   *
   * | runtime     | how                                            |
   * | ----------- | ---------------------------------------------- |
   * | claude-code | `MAX_THINKING_TOKENS` in the environment        |
   * | codex       | `-c model_reasoning_effort="<effort>"`          |
   */
  readonly reasoningEffort?: ReasoningEffort
  /** Codex only: request fast or standard processing; absent inherits the runtime default. */
  readonly fastMode?: boolean
  readonly credential?: RuntimeCredential
  readonly resumeSessionId?: string
  readonly mcp?: McpOptions
  /** Machine-visible path of a file appended to the system prompt (claude-code only). */
  readonly systemPromptFile?: string
  /**
   * Extra directories the agent may touch (`agent_file_grants`), writable — `ro` is not
   * distinguished on the command line:
   *
   * | runtime     | how                                                                  |
   * | ----------- | -------------------------------------------------------------------- |
   * | claude-code | `--add-dir <dir>…`                                                    |
   * | codex       | `--add-dir <dir>` per dir                                             |
   * | opencode    | ignored here; `opencodePermission(grants)` merged into `opencode.json` |
   * | cursor      | ignored (no flag); listed in the instruction file only               |
   *
   * Every runtime also gets the grants listed in its instruction file (`instructions.ts`).
   */
  readonly addDirs?: ReadonlyArray<string>
  readonly maxBudgetUsd?: number
}

export interface CommandFile {
  /** Machine-visible path. */
  readonly path: string
  readonly content: string
  readonly mode?: number
}

export interface BuiltCommand {
  readonly cmd: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** Prompt (or anything else) to feed on stdin. */
  readonly stdin?: string
  /** Files to `putFile` before exec (e.g. codex `auth.json` for `openai.oauth`). Contain secrets. */
  readonly files?: ReadonlyArray<CommandFile>
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind
  /** Executable name looked up on the machine's PATH. */
  readonly binary: string
  /**
   * Whether this CLI says anything at all about how full its window is
   * (docs/build-plan-context-meter.md D5). False for `cursor`, which reports no
   * usage of any kind — the meter must say so rather than draw an empty ring.
   */
  readonly contextReported: boolean
  /**
   * Whether the CLI compacts its own context without being asked (D9). Shown on
   * the meter, and the reason a sample may come back smaller than the one before.
   */
  readonly compactsAutomatically: boolean
  /** Real check: binary present and `--version` parses. */
  detect(machine: Machine): Effect.Effect<DetectResult, ExecFailed>
  buildCommand(input: BuildCommandInput): BuiltCommand
  /**
   * One stdout line → zero or more events. Zero for known noise (hook events,
   * rate-limit pings); `raw` for anything unrecognised, including non-JSON.
   * Returns an array rather than an `Option` because one claude `assistant`
   * line can carry several content blocks and one `result` line yields
   * `usage` + `done`.
   */
  parseLine(line: string): ReadonlyArray<AgentEvent>
  /** Arguments that resume `sessionId` (docs/agent-model.md §9 park/resume). */
  resumeArgs(sessionId: string): ReadonlyArray<string>
}
