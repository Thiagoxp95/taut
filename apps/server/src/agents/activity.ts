import type { AgentEvent } from '@taut/runtime'

/**
 * The running commentary under a streaming reply (docs/build-plan-activity.md).
 *
 * A reply that has not written its first token used to be an orb and nothing else, which
 * says "alive" and stops there. These functions turn the two things the runtimes do tell us
 * — a brief progress summary, and the tool it just reached for — into one short line a
 * reader can follow: *"Reading live.ts"*, *"Running pnpm test"*, *"Searching for AgentEvent"*.
 *
 * Everything here is presentation. It is broadcast, never stored, and never becomes part of
 * the message body (D2) — the body is the answer, and a paragraph of tool chatter inside it
 * is a paragraph the reader has to scroll past forever.
 */

/** One line, at most this long. Longer than a chat column, short enough never to wrap twice. */
const MAX = 140

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u)

const str = (u: unknown): string | undefined =>
  typeof u === 'string' && u.trim().length > 0 ? u.trim() : undefined

/** Collapse to one line and cut on a word boundary, so the tail is never half a word. */
export const oneLine = (text: string, max = MAX): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * Only explicit, model-written progress summaries are public activity. Buffer tags across
 * chunks, but never derive a status by clipping reasoning or candidate answer text.
 */
export const makeActivitySummary = () => {
  let pending = ''
  let messageId: string | undefined
  return (event: AgentEvent): string | undefined => {
    if (event.type === 'tool_use' || event.type === 'tool_result') {
      pending = ''
      messageId = undefined
      return undefined
    }
    if (event.type !== 'text_delta') return undefined
    if (event.snapshot || (event.messageId !== undefined && event.messageId !== messageId)) {
      pending = ''
    }
    messageId = event.messageId
    pending += event.text
    let latest: string | undefined
    let consumed = 0
    for (const match of pending.matchAll(/<taut-status>([\s\S]*?)<\/taut-status>/g)) {
      const text = match[1]?.replace(/\s+/g, ' ').trim() ?? ''
      if (text.length > 0 && text.length <= MAX) latest = text
      consumed = (match.index ?? 0) + match[0].length
    }
    pending = pending.slice(consumed)
    // Retain only enough for an unfinished short status (or a split opening tag).
    if (pending.length > 512) pending = pending.slice(-512)
    return latest
  }
}

/** Status markup is temporary even if a runtime repeats it in its final result. */
export const withoutActivitySummary = (text: string): string =>
  text.replace(/<taut-status>[\s\S]*?(?:<\/taut-status>|$)/g, '').trim()

/** `apps/web/src/lib/live.ts` → `lib/live.ts`. Enough to recognise, short enough to read. */
const shortPath = (path: string): string => {
  const parts = path.split('/').filter((p) => p.length > 0 && p !== '.')
  return parts.slice(-2).join('/')
}

const pathOf = (input: Record<string, unknown>): string | undefined => {
  const raw =
    str(input['file_path']) ??
    str(input['filePath']) ??
    str(input['notebook_path']) ??
    str(input['path'])
  return raw === undefined ? undefined : shortPath(raw)
}

/**
 * A tool name as any of the four runtimes spells it, reduced to one word we can phrase:
 * `mcp__taut__post_message` → `post_message`, `codex.command_execution` → `command_execution`,
 * `Read` → `read`.
 */
const normalize = (name: string): string => {
  const tail = name.includes('__')
    ? (name.split('__').pop() ?? name)
    : name.includes('.')
      ? (name.split('.').pop() ?? name)
      : name
  return tail.toLowerCase()
}

/** `mcp__taut__post_message` is Taut's own MCP; the agent is talking to us, not to a file. */
const isTautTool = (name: string): boolean => name.startsWith('mcp__taut__')
export const isBrowserTool = (name: string): boolean =>
  name.startsWith('mcp__browser__') || normalize(name).startsWith('browser_')

/**
 * One tool call, phrased for a reader. Falls back to the tool's own name rather than
 * inventing a verb for something we have never seen — an unknown tool still says *something*
 * is happening, which is the whole job.
 */
export const describeTool = (name: string, input: unknown): string => {
  const args = isRecord(input) ? input : {}
  const key = normalize(name)
  const path = pathOf(args)

  if (isTautTool(name)) return oneLine(`Using Taut · ${key.replace(/_/g, ' ')}`)
  if (isBrowserTool(name)) {
    const url = str(args['url'])
    return oneLine(url === undefined ? 'Driving the browser' : `Opening ${url}`)
  }

  switch (key) {
    case 'read':
    case 'notebookread':
      return oneLine(path === undefined ? 'Reading a file' : `Reading ${path}`)
    case 'write':
      return oneLine(path === undefined ? 'Writing a file' : `Writing ${path}`)
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'apply_patch':
      return oneLine(path === undefined ? 'Editing a file' : `Editing ${path}`)
    case 'bash':
    case 'shell':
    case 'command_execution':
    case 'local_shell_call': {
      const command = str(args['command']) ?? str(args['cmd'])
      const joined = Array.isArray(args['command'])
        ? args['command'].filter((p): p is string => typeof p === 'string').join(' ')
        : undefined
      const line = command ?? joined
      return oneLine(line === undefined ? 'Running a command' : `Running ${line}`, 80)
    }
    case 'bashoutput':
      return 'Watching a command'
    case 'grep':
    case 'search':
    case 'codebase_search': {
      const pattern = str(args['pattern']) ?? str(args['query'])
      return oneLine(pattern === undefined ? 'Searching the code' : `Searching for ${pattern}`)
    }
    case 'glob':
    case 'list':
    case 'ls': {
      const pattern = str(args['pattern']) ?? str(args['path'])
      return oneLine(pattern === undefined ? 'Looking through files' : `Looking for ${pattern}`)
    }
    case 'webfetch':
    case 'fetch': {
      const url = str(args['url'])
      return oneLine(url === undefined ? 'Fetching a page' : `Fetching ${url}`)
    }
    case 'websearch':
    case 'web_search': {
      const query = str(args['query'])
      return oneLine(query === undefined ? 'Searching the web' : `Searching the web for ${query}`)
    }
    case 'task':
    case 'agent':
      return oneLine(`Delegating to a subagent`)
    case 'todowrite':
    case 'todo_list':
      return 'Updating its plan'
    case 'skill':
      return oneLine(`Loading a skill`)
    default:
      return oneLine(`Using ${key.replace(/_/g, ' ')}`)
  }
}
