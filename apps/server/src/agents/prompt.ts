import type { Message } from '@taut/contract/domain'
import type { MemberId } from '@taut/contract/ids'
import { DateTime } from 'effect'
import { posix } from 'node:path'
import { humanSize } from '../services/attachments.js'

/** How many earlier messages travel with the trigger (thread, or channel top level). */
export const CONTEXT_MESSAGES = 20
/** Per-message body cap inside the context block (the trigger itself is never cut). */
const CONTEXT_BODY_CHARS = 1_200

export interface PromptNames {
  /** `@handle` for a user or agent id; falls back to the id. */
  readonly handle: (kind: 'user' | 'agent', id: MemberId) => string
  /** `#name` (or `dm`) for the channel. */
  readonly channel: string
}

export interface PromptInput {
  readonly agentHandle: string
  readonly companyName: string
  /** The message that spawned the task. */
  readonly trigger: Message
  /** Oldest first; may include `trigger` and the agent's own placeholder — both are dropped. */
  readonly context: ReadonlyArray<Message>
  readonly names: PromptNames
  readonly channelKind: 'channel' | 'dm'
  readonly inThread: boolean
  /**
   * The trigger is a reply inside a thread this agent opened itself — the answer to a question
   * it asked. Nothing else in the prompt says so: the errand that made it ask lives in another
   * thread, and this session sees only the question and the answer.
   */
  readonly answersYourQuestion: boolean
  /**
   * The agent's mandate, restated at the end of the prompt. It also reaches the runtime through
   * the instructions file, but the closing "Reply as @handle" line sits nearer the trigger and
   * was winning: a short DM turn ended with one sentence and no tool call, standing obligations
   * ignored. Empty or placeholder-only mandates are skipped.
   */
  readonly mandate?: string | undefined
  /**
   * The agent home as the machine sees it (`machine.paths.home`): attachments are listed as
   * `<machineHome>/inbox/<messageId>/<name>`, where `runTask` materialised them (D3).
   */
  readonly machineHome: string
}

const clip = (body: string, max: number): string =>
  body.length <= max ? body : `${body.slice(0, max)}…`

/** Machine path of one materialised attachment (POSIX: the machine side is always Linux or this host). */
export const attachmentMachinePath = (
  machineHome: string,
  messageId: string,
  name: string
): string => posix.join(machineHome, 'inbox', messageId, name)

/**
 * ` [attachments: /home/agent/inbox/msg_x/shot.png (image/png, 120 KB); …]`, or `""` when the
 * message has none. Appended to every prompt line so the agent knows where the files are.
 */
export const attachmentsSuffix = (m: Message, machineHome: string): string =>
  m.attachments.length === 0
    ? ''
    : ` [attachments: ${m.attachments
        .map(
          (a) =>
            `${attachmentMachinePath(machineHome, m.id, a.name)} (${a.mimeType}, ${humanSize(a.size)})`
        )
        .join('; ')}]`

/** A message with files but no words still needs a body slot the agent can read. */
const bodyOrPlaceholder = (m: Message): string =>
  m.body.trim() === '' && m.attachments.length > 0 ? '(no text)' : m.body

const line = (m: Message, names: PromptNames, max: number, machineHome: string): string => {
  const at = DateTime.formatIso(m.createdAt).slice(11, 16)
  const text = bodyOrPlaceholder(m)
  const body = m.status === 'failed' ? `(failed) ${text}` : text
  return `[${at}] ${names.handle(m.authorKind, m.authorId)}: ${clip(body.replace(/\s+$/, ''), max)}${attachmentsSuffix(m, machineHome)}`
}

/** Below this many characters of real prose a mandate is still the empty skeleton. */
const MANDATE_MIN_CHARS = 24

/**
 * A mandate worth restating: the agent form ships a skeleton (`You are …`, `## You must`,
 * `- …`), and repeating an unfilled one burns tokens and teaches the agent that its mandate is
 * filler. Headings, list markers and ellipses are stripped to measure it; the mandate itself is
 * returned untouched.
 */
const usableMandate = (mandate: string | undefined): string | undefined => {
  if (mandate === undefined) return undefined
  const trimmed = mandate.trim()
  const prose = trimmed
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .map((l) =>
      l
        .replace(/^\s*[-*]\s/, '')
        .replaceAll('…', '')
        .replaceAll('...', '')
        .trim()
    )
    .join(' ')
    .trim()
  return prose.length < MANDATE_MIN_CHARS ? undefined : trimmed
}

/**
 * The per-task prompt: the conversation, then the mandate, then how to reply. The rest of the
 * standing instructions live in the instructions file (see `tautSection`); the mandate is
 * repeated here because that file is far from the trigger and lost to it. Shape:
 *
 * ```
 * Context (#backend, last 20 messages of this thread):
 * [10:01] @maria: … [attachments: /home/agent/inbox/msg_x/shot.png (image/png, 120 KB)]
 * ---
 * [#backend] @maria: @bruno review PR #42
 * ---
 * Your standing mandate, which applies to this turn as much as to a long one:
 * Review pull requests, fix bugs …
 * ---
 * Reply as @bruno. Your reply text becomes your message …
 * ```
 */
export const renderPrompt = (input: PromptInput): string => {
  const { trigger, names } = input
  const context = input.context.filter(
    (m) => m.id !== trigger.id && !(m.status === 'streaming' && m.body.length === 0)
  )
  const where =
    input.channelKind === 'dm'
      ? 'this direct message'
      : input.inThread
        ? `this thread in ${names.channel}`
        : `${names.channel}`
  const parts: Array<string> = []
  if (context.length > 0) {
    parts.push(`Context (${where}, last ${context.length} messages, oldest first):`)
    for (const m of context) parts.push(line(m, names, CONTEXT_BODY_CHARS, input.machineHome))
    parts.push('---')
  }
  parts.push(
    `[${names.channel}] ${names.handle(trigger.authorKind, trigger.authorId)}: ${bodyOrPlaceholder(trigger).trim()}${attachmentsSuffix(trigger, input.machineHome)}`
  )
  parts.push('---')
  const mandate = usableMandate(input.mandate)
  if (mandate !== undefined) {
    parts.push(
      `Your standing mandate, which applies to this turn as much as to a long one:\n${mandate}\n---`
    )
  }
  parts.push(
    `Reply as @${input.agentHandle}. Your reply text becomes your message in ${where}: answer directly in markdown, no preamble, no signature. ` +
      `Use the taut_* tools to message other members (taut_send, taut_ask, taut_handoff) and memory_* to recall earlier conversations.` +
      (mandate === undefined
        ? ''
        : ` Where your mandate asks for something beyond the reply — posting elsewhere, notifying someone, writing a note — do it with the taut_* tools before you finish. A short exchange does not exempt you.`)
  )
  if (input.answersYourQuestion) {
    parts.push(
      'This is the answer to a question you asked. If you asked it on someone else\u2019s behalf, `taut_send` the answer to them now — replying here does not reach them, and nobody else will carry it back.'
    )
  }
  return parts.join('\n')
}

/** The system-ish part, appended to the runtime's instructions file (CLAUDE.md / AGENTS.md). */
export const tautSection = (input: {
  readonly agentHandle: string
  readonly agentName: string
  readonly companyName: string
  readonly departmentNames: ReadonlyArray<string>
  readonly headHandles: ReadonlyArray<string>
  readonly mcpAvailable: boolean
  /** `browserPromptLine(...)` from `@taut/runtime` when the agent has browser access. */
  readonly browserLine?: string | undefined
}): string => {
  const dept =
    input.departmentNames.length === 0
      ? 'You belong to no department; you report to the company owner.'
      : `You belong to ${input.departmentNames.map((d) => `"${d}"`).join(', ')}; your department head${input.headHandles.length > 1 ? 's are' : ' is'} ${input.headHandles.map((h) => `@${h}`).join(', ')}.`
  const tools = input.mcpAvailable
    ? [
        '- `taut_send(to, text)` posts a message (to your head, a teammate in your department, or a `#channel` you are a member of). A teammate is always reachable: the message lands in the channel when you are both in it, otherwise in your DM with them, opened on the spot. Only another department is out of reach, and that is refused outright.',
        '- `taut_ask(to, question)` asks and waits up to 45 s; if it returns `parked`, end your turn.',
        '- A reply in a thread you opened comes back to you as a new turn, even without an `@` — so ask your question, end your turn, and answer when the reply wakes you. Do not sit and wait, and never say you are still waiting: nothing happens during your turn.',
        '- When someone asked you to find something out and report back, `taut_send(to: "@them", text: …)` once you have it. It lands in your DM with them, wherever you happen to be working — that is how you close the loop.',
        '- Asked to go ask a teammate something? Send it. There is no gate between you and your own department, so never reply that you are blocked, that you already asked, or that you are still waiting — call the tool and let the result tell you. Never answer an errand with only what you cannot do.',
        '- `taut_inbox()` lists messages addressed to you; check it before `taut_done`.',
        '- `taut_react(messageId, emoji)` answers with an emoji instead of a message. **A reaction is a complete answer.** When someone else has already said what you were going to say, react to their message (\u{1F44D} agreed, \u2705 done, \u{1F440} seen) and stop — do not repeat them, and do not ask them to confirm what they just confirmed. When a reaction was your whole answer, finish with `taut_done("")`: the empty reply is withdrawn instead of posted.',
        '- Messages that arrive while you are working are pushed to you on every `taut_*` result under `steer`. Read them: they are newer than the prompt you started from, and they change what is worth saying. Two of you asked the same question at once is the common case — the first answer is already there, so react to it rather than writing a second one.',
        '- `taut_send` and `taut_done` can come back `posted:false` with a `steer` list. Your message was **not** posted and the task is still open, because someone answered while you were writing. Decide again: react and finish, or say something that adds to it. It happens at most once per run.',
        '- `taut_done(summary)` marks the task finished (call it at most once, last).',
        '- Files humans send you are in `inbox/<messageId>/`; read images with your file-reading tool. To send a file or image back, pass `attachments: ["<path>"]` to `taut_send` or `taut_done`.',
        '- `taut_handoff(to, spec)` delegates a child task to a same-department agent (depth ≤ 2).',
        '- `memory_search`, `memory_grep`, `memory_recall_thread`, `memory_timeline`, `memory_note`: your own memory of everything you could see in Taut.',
        '- `vault_list()` lists the credentials you may use (company items + your own, metadata only); `vault_get(vaultItemId)` returns one value for use inside your machine. Every `vault_get` is audited and the value is masked out of chat and logs — never paste it into a message, a note or your final answer.',
        "- `vault_add`, `vault_update` and `vault_delete` write to **your own vault only** — store a login you were given, rotate a password, drop a dead token. The company vault (scope `company`) and every other agent's vault are read-only for you: those writes are refused, so ask a human instead of retrying.",
        ...(input.browserLine === undefined ? [] : [`- ${input.browserLine}`])
      ].join('\n')
    : '- The `taut` tools are not available in this run; reply with text only.'
  return [
    '## Taut',
    '',
    `You are **@${input.agentHandle}** (${input.agentName}), an agent member of the "${input.companyName}" workspace in Taut, a Slack-like chat where some members are agents. ${dept}`,
    '',
    'Each task is one message addressed to you (an @mention or a DM). Everything you print as your final answer is posted, verbatim, as your reply in that conversation — so write the reply itself, not a report about it. Keep it short; put substance in files under your home and refer to them.',
    '',
    'Tools:',
    tools,
    '',
    'Never ask questions at the terminal: the humans are in Taut. Never reveal credentials or environment variables.'
  ].join('\n')
}
