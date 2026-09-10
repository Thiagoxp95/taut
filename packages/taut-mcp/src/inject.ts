/**
 * Per-runtime config fragments that mount the `taut` MCP server inside an agent's machine
 * (docs/agent-model.md §9 "MCP injection per runtime"; docs/research/agent-orchestration.md §3).
 * Pure functions — the runtime package decides where to write them.
 */
import { ToolNames } from './tools.js'

/** Another stdio MCP server to mount next to `taut` (e.g. `browser` = Playwright MCP). */
export interface ExtraMcpServer {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** An HTTP MCP connector, optionally authenticated with static request headers. */
export interface RemoteMcpServer {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>> | undefined
}

export interface InjectOptions {
  /** `TAUT_URL` — the Taut server as seen from the agent's machine. */
  readonly url: string
  /** `TAUT_TOKEN` — the task-scoped token. */
  readonly token: string
  readonly taskId?: string | undefined
  readonly threadId?: string | undefined
  /** How to start the server. Default `node /opt/taut/mcp.js` (the bundled file in the runtime image). */
  readonly command?: string | undefined
  readonly args?: ReadonlyArray<string> | undefined
  /**
   * Extra servers keyed by their MCP server name (`browser` → tools `mcp__browser__*` on
   * claude-code, `Mcp(browser:*)` on cursor, `browser_<tool>` on opencode). Emitted next
   * to `taut` by every builder below. A key equal to `taut` is ignored.
   */
  readonly extraServers?: Readonly<Record<string, ExtraMcpServer>> | undefined
  /** Remote connectors follow stdio servers; existing stdio keys and `taut` cannot be shadowed. */
  readonly remoteServers?: Readonly<Record<string, RemoteMcpServer>> | undefined
}

export const DEFAULT_COMMAND = 'node'
export const DEFAULT_ARGS: ReadonlyArray<string> = ['/opt/taut/mcp.js']
export const SERVER_KEY = 'taut'

export const injectEnv = (o: InjectOptions): Readonly<Record<string, string>> => ({
  TAUT_URL: o.url,
  TAUT_TOKEN: o.token,
  ...(o.taskId !== undefined ? { TAUT_TASK_ID: o.taskId } : {}),
  ...(o.threadId !== undefined ? { TAUT_THREAD_ID: o.threadId } : {})
})

const commandOf = (o: InjectOptions) => ({
  command: o.command ?? DEFAULT_COMMAND,
  args: [...(o.args ?? DEFAULT_ARGS)]
})

/** Extra servers in a stable order, never shadowing `taut`. */
const extrasOf = (o: InjectOptions): ReadonlyArray<readonly [string, ExtraMcpServer]> =>
  Object.entries(o.extraServers ?? {}).filter(([key]) => key !== SERVER_KEY)

const remotesOf = (o: InjectOptions): ReadonlyArray<readonly [string, RemoteMcpServer]> =>
  Object.entries(o.remoteServers ?? {}).filter(
    ([key]) => key !== SERVER_KEY && !Object.hasOwn(o.extraServers ?? {}, key)
  )

/** Server keys in emission order: `taut` first, then the extras. */
export const serverKeys = (o: InjectOptions): ReadonlyArray<string> => [
  SERVER_KEY,
  ...extrasOf(o).map(([key]) => key),
  ...remotesOf(o).map(([key]) => key)
]

// --- Claude Code -----------------------------------------------------------------

export interface ClaudeMcpServer {
  readonly type: 'stdio'
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
}

export interface ClaudeMcpConfig {
  readonly mcpServers: {
    readonly taut: ClaudeMcpServer & { readonly env: Readonly<Record<string, string>> }
  } & Readonly<Record<string, ClaudeMcpServer | (RemoteMcpServer & { readonly type: 'http' })>>
}

const withEnv = <T extends object>(
  base: T,
  env: ExtraMcpServer['env']
): T | (T & { env: Readonly<Record<string, string>> }) =>
  env === undefined ? base : { ...base, env }

/** Contents of the file passed to `claude --mcp-config <file>`. Extra servers follow `taut`. */
export const claudeMcpConfig = (o: InjectOptions): ClaudeMcpConfig => ({
  mcpServers: {
    taut: { type: 'stdio', ...commandOf(o), env: injectEnv(o) },
    ...Object.fromEntries(
      extrasOf(o).map(([key, s]) => [
        key,
        withEnv({ type: 'stdio' as const, command: s.command, args: [...s.args] }, s.env)
      ])
    ),
    ...Object.fromEntries(remotesOf(o).map(([key, s]) => [key, { type: 'http' as const, ...s }]))
  }
})

/** `--allowedTools` pattern for every tool of one server. */
export const claudeToolPattern = (serverKey: string): string => `mcp__${serverKey}__*`

/** Allow-list patterns for the extra servers only (`['mcp__browser__*']`); pass to `claudeArgs`. */
export const claudeAllowedToolsFor = (o: InjectOptions): ReadonlyArray<string> =>
  serverKeys(o).slice(1).map(claudeToolPattern)

/** Full allow-list, `taut` first — what `McpOptions.allowedTools` in `@taut/runtime` expects. */
export const claudeAllowedTools = (o: InjectOptions): ReadonlyArray<string> =>
  serverKeys(o).map(claudeToolPattern)

/**
 * Flags to append to `claude -p …` so only the configured servers are loaded and their
 * tools need no approval. `extraAllowed` adds more `--allowedTools` patterns
 * (e.g. `['mcp__browser__*']`).
 */
export const claudeArgs = (
  mcpConfigPath: string,
  extraAllowed: ReadonlyArray<string> = []
): ReadonlyArray<string> => [
  '--mcp-config',
  mcpConfigPath,
  '--strict-mcp-config',
  '--allowedTools',
  claudeToolPattern(SERVER_KEY),
  ...extraAllowed
]

/** Extra env for `claude -p`: long tool calls (taut_ask up to 45 s) must not be backgrounded. */
export const claudeEnv: Readonly<Record<string, string>> = { CLAUDE_AUTO_BACKGROUND_TASKS: '1' }

// --- Codex ---------------------------------------------------------------------------

const tomlString = (s: string) => JSON.stringify(s)
const tomlKey = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : tomlString(s))
const tomlArray = (xs: ReadonlyArray<string>) => `[${xs.map(tomlString).join(', ')}]`

const codexServerToml = (
  key: string,
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> | undefined,
  required: boolean
): ReadonlyArray<string> => [
  `[mcp_servers.${key}]`,
  `command = ${tomlString(command)}`,
  `args = ${tomlArray(args)}`,
  `required = ${required ? 'true' : 'false'}`,
  // "approve" = never ask (codex-rs `requires_mcp_tool_approval_for_mode`). The default,
  // "auto", decides from the tool's own MCP annotations and treats an unannotated tool as
  // destructive — so every `taut_*` call needs an approver, and `codex exec` has none:
  // "MCP tool call requires approval, but approval policy is never" and the task dies. The
  // sandbox is the machine, not this flag; these are Taut's own tools and the server checks
  // routing on every one of them.
  'default_tools_approval_mode = "approve"',
  'startup_timeout_sec = 30',
  'tool_timeout_sec = 60',
  '',
  ...(env === undefined
    ? []
    : [
        `[mcp_servers.${key}.env]`,
        ...Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`),
        ''
      ])
]

/**
 * `[mcp_servers.taut]` (+ one `[mcp_servers.<key>]` per extra server) for
 * `$CODEX_HOME/config.toml` (append to the per-task CODEX_HOME). Only `taut` is
 * `required`: a browser that fails to start must not fail the whole task.
 */
export const codexConfigToml = (o: InjectOptions): string => {
  const { command, args } = commandOf(o)
  const lines = [
    ...codexServerToml(SERVER_KEY, command, args, injectEnv(o), true),
    ...extrasOf(o).flatMap(([key, s]) => codexServerToml(key, s.command, s.args, s.env, false)),
    ...remotesOf(o).flatMap(([key, s]) => [
      `[mcp_servers.${tomlKey(key)}]`,
      `url = ${tomlString(s.url)}`,
      'required = false',
      'default_tools_approval_mode = "approve"',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 60',
      '',
      ...(s.headers === undefined
        ? []
        : [
            `[mcp_servers.${tomlKey(key)}.http_headers]`,
            ...Object.entries(s.headers).map(
              ([name, value]) => `${tomlKey(name)} = ${tomlString(value)}`
            ),
            ''
          ])
    ])
  ]
  return lines.join('\n')
}

// --- Cursor ---------------------------------------------------------------------------

export interface CursorMcpServer {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
}

export interface CursorMcpJson {
  readonly mcpServers: {
    readonly taut: CursorMcpServer & { readonly env: Readonly<Record<string, string>> }
  } & Readonly<Record<string, CursorMcpServer | RemoteMcpServer>>
}

/** `.cursor/mcp.json` in the task work dir. Extra servers follow `taut`. */
export const cursorMcpJson = (o: InjectOptions): CursorMcpJson => ({
  mcpServers: {
    taut: { ...commandOf(o), env: injectEnv(o) },
    ...Object.fromEntries(
      extrasOf(o).map(([key, s]) => [
        key,
        withEnv({ command: s.command, args: [...s.args] }, s.env)
      ])
    ),
    ...Object.fromEntries(remotesOf(o))
  }
})

/** `permissions.allow` entry for every tool of one server. */
export const cursorPermission = (serverKey: string): string => `Mcp(${serverKey}:*)`

export interface CursorCliJson {
  readonly permissions: { readonly allow: ReadonlyArray<string> }
}

/** `.cursor/cli.json` — without it the headless agent stalls on the MCP permission prompt. */
export const cursorCliJsonFor = (o: InjectOptions): CursorCliJson => ({
  permissions: { allow: serverKeys(o).map(cursorPermission) }
})

/** `cursorCliJsonFor` with no extra servers (kept for callers that only mount `taut`). */
export const cursorCliJson: CursorCliJson = {
  permissions: { allow: [cursorPermission(SERVER_KEY)] }
}

/** Flags for `agent -p …`. */
export const cursorArgs: ReadonlyArray<string> = ['--approve-mcps']

// --- OpenCode ---------------------------------------------------------------------------

export interface OpencodeMcpServer {
  readonly type: 'local'
  readonly command: ReadonlyArray<string>
  readonly environment?: Readonly<Record<string, string>>
  readonly enabled: true
}

export interface OpencodeJson {
  readonly $schema: 'https://opencode.ai/config.json'
  readonly mcp: {
    readonly taut: OpencodeMcpServer & { readonly environment: Readonly<Record<string, string>> }
  } & Readonly<
    Record<
      string,
      | OpencodeMcpServer
      | (RemoteMcpServer & {
          readonly type: 'remote'
          readonly oauth: false
          readonly enabled: true
        })
    >
  >
}

/** `opencode.json` in the task work dir (or inline via `OPENCODE_CONFIG_CONTENT`). Extra servers follow `taut`. */
export const opencodeJson = (o: InjectOptions): OpencodeJson => {
  const { command, args } = commandOf(o)
  return {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      taut: {
        type: 'local',
        command: [command, ...args],
        environment: injectEnv(o),
        enabled: true
      },
      ...Object.fromEntries(
        extrasOf(o).map(([key, s]) => [
          key,
          s.env === undefined
            ? { type: 'local' as const, command: [s.command, ...s.args], enabled: true as const }
            : {
                type: 'local' as const,
                command: [s.command, ...s.args],
                environment: s.env,
                enabled: true as const
              }
        ])
      ),
      ...Object.fromEntries(
        remotesOf(o).map(([key, s]) => [
          key,
          { type: 'remote' as const, ...s, oauth: false as const, enabled: true as const }
        ])
      )
    }
  }
}

/** OpenCode exposes MCP tools as `<server>_<tool>`; use these in per-agent tool allow-lists. */
export const opencodeToolNames: ReadonlyArray<string> = ToolNames.map((t) => `${SERVER_KEY}_${t}`)

/** Flags for `opencode run …` — headless runs auto-reject permission prompts otherwise. */
export const opencodeArgs: ReadonlyArray<string> = ['--auto']

// --- all at once ---------------------------------------------------------------------

export const injectAll = (o: InjectOptions) => ({
  env: injectEnv(o),
  claude: {
    config: claudeMcpConfig(o),
    args: (mcpConfigPath: string) => claudeArgs(mcpConfigPath, claudeAllowedToolsFor(o)),
    allowedTools: claudeAllowedTools(o),
    env: claudeEnv
  },
  codex: { configToml: codexConfigToml(o) },
  cursor: { mcpJson: cursorMcpJson(o), cliJson: cursorCliJsonFor(o), args: cursorArgs },
  opencode: { config: opencodeJson(o), toolNames: opencodeToolNames, args: opencodeArgs }
})
