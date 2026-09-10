/**
 * `taut` CLI — the tool table, mirrored 1:1, for runtimes without MCP and for shell scripts.
 * `parseArgs` is pure; `runCli` returns what to print so tests need no process spawning.
 *
 * One subcommand is not a tool: `taut git-credential <get|store|erase>` is a **git credential
 * helper** (docs/build-plan-repositories.md D4). `git` runs it as `!taut git-credential` — set
 * per exec through `GIT_CONFIG_*`, never written into a config file — and speaks its
 * `key=value` block on stdin. `get` trades the task's own bearer token for a fresh
 * repository-scoped installation token and prints it; `store` and `erase` do nothing, because
 * the whole point is that no token is ever kept. **Every failure exits 0 printing nothing**:
 * git then reports "could not read Username", which is a failed clone, while a helper that
 * errored or hung would leave git sitting on a terminal prompt inside a box with no terminal.
 */
import { Effect } from 'effect'
import { TautClient } from './client.js'
import { STEER_PREAMBLE } from './protocol.js'
import type {
  InboxMessage,
  MemoryHit,
  MemoryItem,
  SteerItem,
  VaultItemSummary
} from './protocol.js'
import { describeToolError, runTool, tools } from './tools.js'
import type { ToolName } from './tools.js'

export const USAGE = `taut — talk to your Taut workspace (env: TAUT_URL, TAUT_TOKEN)

  taut send <@handle|#channel> <text…>      [--thread <id>] [--attach a,b]
  taut delete <messageId>                  remove your own message or obsolete approval card
  taut inbox                                [--since <seq>]
  taut ask <@handle> <question…>            [--timeout <sec≤45>]
  taut done <summary…>                      [--failed] [--files a,b] [--attach a,b]
  taut handoff <@handle> <spec…>
  taut agents [query…]                      find same-department specialists [--limit n]
  taut react <messageId> <emoji>            [--off]        react instead of writing a reply
  taut mem search <query…>                  [--limit n] [--since iso] [--until iso] [--channel id] [--kind k] [--author id]
  taut mem grep <pattern>                   [--limit n] [--since iso] [--until iso] [--channel id] [--kind k] [--flags f]
  taut mem recall <threadId>                [--limit n]
  taut mem timeline <from> <to>             [--channel id] [--limit n]
  taut mem note <text…>                     [--tags a,b]
  taut mem notes                            [--limit n]
  taut mem forget <id>
  taut vault list                           credentials you may use (no values)
  taut vault get <vaultItemId>              prints the secret value only (pipe it; never echo it into chat)
  taut vault add <label> --secret <value>   store it in YOUR OWN vault [--kind generic.secret]
  taut vault set <vaultItemId>              change your own item [--label l] [--secret v]
  taut vault rm <vaultItemId>               delete your own item (company items are read-only)
  taut pr <owner/name> <title…>             open a pull request [--body b] [--head h] [--base b]
  taut git-credential <get|store|erase>     git credential helper; reads git's block on stdin
  taut describe                             print every tool with its JSON schema
  taut help

  --json on any command prints the raw result.`

export type Parsed =
  | {
      readonly _tag: 'tool'
      readonly tool: ToolName
      readonly input: Record<string, unknown>
      readonly json: boolean
    }
  | { readonly _tag: 'describe'; readonly json: boolean }
  /** Not a tool: git speaks to this one over stdin and reads its stdout (see the header). */
  | { readonly _tag: 'git-credential'; readonly op: string }
  | { readonly _tag: 'help' }
  | { readonly _tag: 'error'; readonly message: string }

interface Flags {
  readonly positional: ReadonlyArray<string>
  readonly flags: Readonly<Record<string, string | true>>
}

const splitFlags = (argv: ReadonlyArray<string>): Flags => {
  const positional: Array<string> = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (a === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const name = a.slice(2)
      const next = argv[i + 1]
      if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('--')) flags[name] = true
      else {
        flags[name] = next
        i++
      }
    } else positional.push(a)
  }
  return { positional, flags }
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['json', 'failed', 'help'])

const str = (f: Flags, name: string): string | undefined => {
  const v = f.flags[name]
  return typeof v === 'string' ? v : undefined
}
const num = (f: Flags, name: string): number | undefined => {
  const v = str(f, name)
  return v === undefined ? undefined : Number(v)
}
const list = (f: Flags, name: string): ReadonlyArray<string> | undefined => {
  const v = str(f, name)
  return v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
}
const defined = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

const tool = (name: ToolName, input: Record<string, unknown>, json: boolean): Parsed => ({
  _tag: 'tool',
  tool: name,
  input: defined(input),
  json
})
const error = (message: string): Parsed => ({ _tag: 'error', message: `${message}\n\n${USAGE}` })

export const parseArgs = (argv: ReadonlyArray<string>): Parsed => {
  const f = splitFlags(argv)
  const json = f.flags['json'] === true
  const [cmd, ...rest] = f.positional
  if (cmd === undefined || cmd === 'help' || f.flags['help'] === true) return { _tag: 'help' }
  const text = (from: number) => rest.slice(from).join(' ')

  switch (cmd) {
    case 'agents':
      return tool(
        'taut_agent_search',
        { query: rest.length === 0 ? undefined : text(0), limit: num(f, 'limit') },
        json
      )
    case 'send':
      if (rest.length < 2) return error('send needs <to> and <text>')
      return tool(
        'taut_send',
        { to: rest[0], text: text(1), threadId: str(f, 'thread'), attachments: list(f, 'attach') },
        json
      )
    case 'delete':
      if (rest.length !== 1) return error('delete needs <messageId>')
      return tool('taut_delete', { messageId: rest[0] }, json)
    case 'inbox':
      return tool('taut_inbox', { since: num(f, 'since') }, json)
    case 'ask':
      if (rest.length < 2) return error('ask needs <to> and <question>')
      return tool('taut_ask', { to: rest[0], text: text(1), timeoutSec: num(f, 'timeout') }, json)
    case 'done':
      if (rest.length < 1) return error('done needs <summary>')
      return tool(
        'taut_done',
        {
          summary: text(0),
          outcome: f.flags['failed'] === true ? 'failed' : undefined,
          filesChanged: list(f, 'files'),
          attachments: list(f, 'attach')
        },
        json
      )
    case 'handoff':
      if (rest.length < 2) return error('handoff needs <to> and <spec>')
      return tool('taut_handoff', { to: rest[0], text: text(1) }, json)
    case 'react':
      if (rest.length < 2) return error('react needs <messageId> and <emoji>')
      return tool(
        'taut_react',
        { messageId: rest[0], emoji: rest[1], on: f.flags['off'] === true ? false : undefined },
        json
      )
    case 'describe':
      return { _tag: 'describe', json }
    case 'pr':
      if (rest.length < 2) return error('pr needs <owner/name> and <title>')
      return tool(
        'github_open_pr',
        {
          repo: rest[0],
          title: text(1),
          body: str(f, 'body') ?? '',
          head: str(f, 'head'),
          base: str(f, 'base')
        },
        json
      )
    // `git-credential` never reaches `runTool`: git owns both ends of it.
    case 'git-credential':
      return { _tag: 'git-credential', op: rest[0] ?? '' }
    case 'vault': {
      const [sub, ...args] = rest
      switch (sub) {
        case 'list':
        case 'ls':
          return tool('vault_list', {}, json)
        case 'get':
          if (args[0] === undefined) return error('vault get needs <vaultItemId>')
          return tool('vault_get', { vaultItemId: args[0] }, json)
        // Writes land in the caller's own vault. There is no scope flag on purpose: the
        // company vault and other agents' vaults are read-only for an agent.
        case 'add': {
          const label = args.join(' ')
          const secret = str(f, 'secret')
          if (label === '') return error('vault add needs <label>')
          if (secret === undefined) return error('vault add needs --secret <value>')
          return tool(
            'vault_add',
            { kind: str(f, 'kind') ?? 'generic.secret', label, secret },
            json
          )
        }
        case 'set':
        case 'update': {
          if (args[0] === undefined) return error('vault set needs <vaultItemId>')
          const label = str(f, 'label')
          const secret = str(f, 'secret')
          if (label === undefined && secret === undefined) {
            return error('vault set needs --label and/or --secret')
          }
          return tool('vault_update', { vaultItemId: args[0], label, secret }, json)
        }
        case 'rm':
        case 'delete':
          if (args[0] === undefined) return error('vault rm needs <vaultItemId>')
          return tool('vault_delete', { vaultItemId: args[0] }, json)
        default:
          return error(`unknown vault command "${sub ?? ''}"`)
      }
    }
    case 'mem':
    case 'memory': {
      const [sub, ...args] = rest
      const common = {
        limit: num(f, 'limit'),
        since: str(f, 'since'),
        until: str(f, 'until'),
        channelId: str(f, 'channel'),
        kind: str(f, 'kind')
      }
      switch (sub) {
        case 'search':
          if (args.length < 1) return error('mem search needs <query>')
          return tool(
            'memory_search',
            { query: args.join(' '), ...common, authorId: str(f, 'author') },
            json
          )
        case 'grep':
          if (args.length < 1) return error('mem grep needs <pattern>')
          return tool(
            'memory_grep',
            { pattern: args.join(' '), ...common, flags: str(f, 'flags') },
            json
          )
        case 'recall':
          if (args[0] === undefined) return error('mem recall needs <threadId>')
          return tool('memory_recall_thread', { threadId: args[0], limit: num(f, 'limit') }, json)
        case 'timeline':
          if (args[0] === undefined || args[1] === undefined)
            return error('mem timeline needs <from> <to>')
          return tool(
            'memory_timeline',
            { from: args[0], to: args[1], channelId: str(f, 'channel'), limit: num(f, 'limit') },
            json
          )
        case 'note':
          if (args.length < 1) return error('mem note needs <text>')
          return tool('memory_note', { text: args.join(' '), tags: list(f, 'tags') }, json)
        case 'notes':
          return tool('memory_notes_list', { limit: num(f, 'limit') }, json)
        case 'forget':
          if (args[0] === undefined) return error('mem forget needs <id>')
          return tool('memory_forget', { id: args[0] }, json)
        default:
          return error(`unknown mem command "${sub ?? ''}"`)
      }
    }
    default:
      return error(`unknown command "${cmd}"`)
  }
}

// --- human rendering -----------------------------------------------------------

const when = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z')

const renderInbox = (m: InboxMessage) => {
  const head = `[${m.seq}] ${when(m.at)} @${m.from.handle}${m.channelName ? ` in #${m.channelName}` : ''}${m.intent ? ` (${m.intent})` : ''}: ${m.text}`
  const files = m.attachments ?? []
  return files.length === 0
    ? head
    : `${head}\n  attachments: ${files.map((a) => `${a.path} (${a.mimeType}, ${a.size} B)`).join('; ')}`
}

const renderItem = (i: MemoryItem | MemoryHit) => {
  const who = i.authorHandle ?? i.authorId ?? '?'
  const where = i.channelId === null ? '' : ` in ${i.channelId}`
  const head = `${when(i.at)} ${i.kind} ${i.id} @${who}${where}${i.threadId ? ` thread:${i.threadId}` : ''}`
  const body = 'snippet' in i ? i.snippet.replace(/\n/g, ' ') : i.body
  return `${head}\n  ${body}`
}

/**
 * Messages that landed while the run was in flight (docs/build-plan-steering-reactions.md D6).
 * Printed above whatever the command itself returned, so it is read first.
 */
const renderSteer = (r: Record<string, unknown>): string => {
  const items = Array.isArray(r['steer']) ? (r['steer'] as ReadonlyArray<SteerItem>) : []
  if (items.length === 0) return ''
  const rows = items.map((m) => `  @${m.from.handle}: ${m.text}  (${m.messageId})`).join('\n')
  return `--- new since you started ---\n${STEER_PREAMBLE}\n${rows}\n---\n`
}

const renderHuman = (name: ToolName, r: Record<string, unknown>): string => {
  const items = Array.isArray(r['items']) ? (r['items'] as ReadonlyArray<unknown>) : undefined
  switch (name) {
    case 'taut_send':
      return r['posted'] === false
        ? `not posted — steered: ${String(r['hint'])}`
        : `sent ${String(r['messageId'])} (seq ${String(r['seq'])})`
    case 'taut_delete':
      return `deleted ${String(r['messageId'])}`
    case 'taut_inbox': {
      const rows = (items ?? []) as ReadonlyArray<InboxMessage>
      return rows.length === 0
        ? `inbox empty (nextSince ${String(r['nextSince'])})`
        : `${rows.map(renderInbox).join('\n')}\nnextSince ${String(r['nextSince'])}`
    }
    case 'taut_ask':
      if (r['parked'] === true)
        return `parked: no answer within the timeout. askId ${String(r['askId'])}. End your turn.`
      return `answer: ${JSON.stringify(r['answer'])}`
    case 'taut_done':
      if (r['posted'] === false) return `not finished — steered: ${String(r['hint'])}`
      return `task ${String(r['taskId'])} ${String(r['status'])}${r['withdrew'] === true ? ' (empty reply withdrawn)' : ''}`
    case 'taut_handoff':
      return `child task ${String(r['taskId'])} (thread ${String(r['threadId'])})`
    case 'taut_react': {
      const on = r['on'] === true
      const all = (r['reactions'] ?? []) as ReadonlyArray<{ emoji: string; count: number }>
      return `${on ? 'reacted' : 'un-reacted'} ${String(r['emoji'])} on ${String(r['messageId'])}${
        all.length === 0 ? '' : ` — now ${all.map((x) => `${x.emoji}${x.count}`).join(' ')}`
      }`
    }
    case 'memory_note':
      return `note ${String((r['item'] as MemoryItem | undefined)?.id)} saved`
    case 'memory_forget':
      return r['deleted'] === true ? 'forgotten' : 'no such note'
    case 'vault_list': {
      const rows = (items ?? []) as ReadonlyArray<VaultItemSummary>
      return rows.length === 0
        ? 'no vault items'
        : rows
            .map(
              (v) =>
                `${v.id}  ${v.scope.padEnd(7)} ${v.kind}  ${v.label}  ${v.hint}${v.lastUsedAt ? `  last used ${when(v.lastUsedAt)}` : ''}`
            )
            .join('\n')
    }
    case 'vault_get':
      // Value only, so `TOKEN=$(taut vault get <id>)` works. Nothing else is printed.
      return String(r['secret'])
    case 'github_open_pr':
      return `pull request #${String(r['number'])} — ${String(r['url'])}`
    default: {
      const rows = (items ?? []) as ReadonlyArray<MemoryItem | MemoryHit>
      return rows.length === 0 ? 'no results' : rows.map(renderItem).join('\n')
    }
  }
}

export interface CliResult {
  readonly stdout: string
  readonly exitCode: number
}

// --- the git credential helper (docs/build-plan-repositories.md D4) --------------

/** Anything short of a full answer: say nothing, exit 0, let git fall through to "no auth". */
const NO_CREDENTIAL: CliResult = { stdout: '', exitCode: 0 }

/**
 * git's credential block: `key=value` lines, terminated by a blank line or EOF. Values may
 * contain `=`, keys never do. Unknown keys (`url`, `wwwauth[]`, `capability[]`…) are ignored.
 */
export const parseCredentialBlock = (stdin: string): Readonly<Record<string, string>> => {
  const fields: Record<string, string> = {}
  for (const line of stdin.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed === '') break
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    fields[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return fields
}

/**
 * `get` asks the server for a repository-scoped token and prints it in git's own format;
 * `store` and `erase` are no-ops (there is nothing on disk to keep or wipe). The token appears
 * on stdout and nowhere else — not in a log line, not in an error, not on stderr.
 */
const gitCredential = (op: string, stdin: string): Effect.Effect<CliResult, never, TautClient> => {
  if (op !== 'get') return Effect.succeed(NO_CREDENTIAL)
  const fields = parseCredentialBlock(stdin)
  const host = fields['host']
  const path = fields['path']
  // Only https, only a host we were asked about, and only with the repository path — without
  // it the server cannot tell which repository this is, so there is nothing to ask for.
  if (
    host === undefined ||
    host === '' ||
    path === undefined ||
    path === '' ||
    (fields['protocol'] ?? 'https') !== 'https'
  ) {
    return Effect.succeed(NO_CREDENTIAL)
  }
  return Effect.gen(function* () {
    const client = yield* TautClient
    const answer = yield* client.gitCredential({ host, path })
    return {
      stdout: `username=${answer.username}\npassword=${answer.password}`,
      exitCode: 0
    }
  }).pipe(Effect.catchAll(() => Effect.succeed(NO_CREDENTIAL)))
}

/**
 * Parse + run. Never fails: errors become `exitCode 1` with the message on `stdout`.
 * `stdin` is only read by `git-credential`; every other command ignores it.
 */
export const runCli = (
  argv: ReadonlyArray<string>,
  stdin = ''
): Effect.Effect<CliResult, never, TautClient> => {
  const parsed = parseArgs(argv)
  switch (parsed._tag) {
    case 'help':
      return Effect.succeed({ stdout: USAGE, exitCode: 0 })
    case 'git-credential':
      return gitCredential(parsed.op, stdin)
    case 'error':
      return Effect.succeed({ stdout: parsed.message, exitCode: 1 })
    case 'describe': {
      const described = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
      return Effect.succeed({
        stdout: parsed.json
          ? JSON.stringify(described, null, 2)
          : described
              .map(
                (t) =>
                  `${t.name}\n  ${t.description}\n  args: ${JSON.stringify(t.inputSchema.properties)}`
              )
              .join('\n\n'),
        exitCode: 0
      })
    }
    case 'tool':
      return runTool(parsed.tool, parsed.input).pipe(
        Effect.map((result) => ({
          stdout: parsed.json
            ? JSON.stringify(result, null, 2)
            : renderSteer(result) + renderHuman(parsed.tool, result),
          exitCode: 0
        })),
        Effect.catchAll((e) =>
          Effect.succeed({
            stdout: parsed.json
              ? JSON.stringify({ error: { tag: e._tag, message: describeToolError(e) } }, null, 2)
              : `error: ${describeToolError(e)}`,
            exitCode: 1
          })
        )
      )
  }
}
