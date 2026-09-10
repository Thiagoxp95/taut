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
  /**
   * The ticket this thread is about, already rendered (`agents/issueContext.ts`,
   * docs/build-plan-issues.md D17). Set only in an issue thread, which is a
   * vanishing minority of runs — and in those it goes *first*, before the
   * conversation, because it is what "it" refers to in every line that follows.
   */
  readonly issue?: string | undefined
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
  const reactions = m.reactions
    .map(
      (r) =>
        `${r.emoji} ${r.members.map((member) => names.handle(member.kind, member.id)).join(', ')}`
    )
    .join('; ')
  return `[${at}] ${names.handle(m.authorKind, m.authorId)}: ${clip(body.replace(/\s+$/, ''), max)}${attachmentsSuffix(m, machineHome)} [messageId: ${m.id}${reactions === '' ? '' : `; reactions: ${reactions}`}]`
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
  const context = input.context.filter((m) => m.id !== trigger.id && m.status !== 'streaming')
  const where =
    input.channelKind === 'dm'
      ? 'this direct message'
      : input.inThread
        ? `this thread in ${names.channel}`
        : `${names.channel}`
  const parts: Array<string> = []
  // The ticket first (D17): everything below it is a conversation *about* it.
  if (input.issue !== undefined && input.issue.trim() !== '') parts.push(input.issue)
  parts.push(
    'Request that queued this turn (the conversation below may have advanced since):',
    `[${names.channel}] ${names.handle(trigger.authorKind, trigger.authorId)}: ${bodyOrPlaceholder(trigger).trim()}${attachmentsSuffix(trigger, input.machineHome)} [messageId: ${trigger.id}]`,
    '---'
  )
  if (context.length > 0) {
    parts.push(`Context (${where}, last ${context.length} messages, oldest first):`)
    for (const m of context) parts.push(line(m, names, CONTEXT_BODY_CHARS, input.machineHome))
    parts.push('---')
  }
  const mandate = usableMandate(input.mandate)
  if (mandate !== undefined) {
    parts.push(
      `Your standing mandate, which applies to this turn as much as to a long one:\n${mandate}\n---`
    )
  }
  parts.push(
    `Reply as @${input.agentHandle}. Your final answer becomes your message in ${where}: answer directly in markdown, no preamble, no signature. Before a tool call or between tool calls when your focus changes, write a brief public progress summary as <taut-status>Comparing color options</taut-status>. Use 3–8 words describing the current action, at most 140 characters, in the conversation’s language. Summarize what you are doing, never your private reasoning or a draft answer. These summaries replace the same temporary status line. Keep status tags out of your final answer. The final answer must stand on its own and include only the outcome, essential context, and any question or next step the reader needs. ` +
      `Use the taut_* tools to message other members (taut_send, taut_ask, taut_handoff) and memory_* to recall earlier conversations.` +
      (mandate === undefined
        ? ''
        : ` Where your mandate asks for something beyond the reply — posting elsewhere, notifying someone, writing a note — do it with the taut_* tools before you finish. A short exchange does not exempt you.`)
  )
  parts.push(
    'Agents take turns in this thread. You have the floor now; other agents wait until your turn ends. Read the latest messages and reactions before replying to the original request. ' +
      'When discussing a choice, contribute your reasoning or objection and address the next teammate with an @mention in your final answer, then end your turn so they can respond. Do not wait or poll for them during your turn. ' +
      'When the user asks you and a teammate to discuss and agree, use separate turns: (1) propose a choice with your reason and @mention the teammate; (2) the teammate argues their case or explicitly accepts in a reply, @mentioning you; (3) after that acceptance, one of you reports the shared decision and @mentions the other for acknowledgment. An opening proposal is not a decision report. A decision report must not ask whether the teammate agrees: that has already happened. ' +
      'Only after the shared decision is reported should the other agent use a reaction-only acknowledgment: react 👍 to that report and call taut_done(""). Do not send a second report, ask for confirmation again, or narrate the reaction. ' +
      'If taut_send already posted your contribution in this thread, call taut_done("") to yield without repeating it.'
  )
  const hasTeammateContribution = [trigger, ...context].some(
    (m) =>
      m.authorKind === 'agent' &&
      m.status === 'sent' &&
      m.body.trim() !== '' &&
      names.handle(m.authorKind, m.authorId) !== `@${input.agentHandle}`
  )
  if (!hasTeammateContribution) {
    parts.push(
      'No teammate has contributed to this conversation yet. If you were asked for a joint decision, you are opening the discussion: label your position as a proposal, explain it briefly, and invite the teammate to respond. You cannot report a shared decision on this turn.'
    )
  }
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
        '- To DM someone, use `taut_send({to: "@handle", text: "…", delivery: "dm"})` (or `taut_ask` with the same delivery). Your department head is always reachable: your own DM opens automatically without approval or prior membership. Never address `#dm` or try to join another agent’s private conversation. Only say it was sent after the tool returns `posted:true`.',
        '- Use `ask_user_question` for human decisions: 1–4 questions, usually 3–4 choices each, optional multiSelect, and a built-in free-text answer. Use unique question IDs and choice labels. This is the supported alternative to terminal AskUserQuestion/request_user_input, which cannot reach Taut users. When parked, end your turn without taut_done; the answer resumes you.',
        '- Use `render_component` to show an inline themed card or timer. Timers require durationSeconds and onComplete instructions and schedule a durable agent wake even with the app closed. Do not schedule a second signal for the same timer. Finish your current turn and act when woken. Use canvas_create for custom visuals.',
        '- `taut_ask(to, question)` parks immediately when a teammate needs this thread’s floor, otherwise waits up to 45 s. If it returns `parked`, end your turn without a waiting message.',
        '- A reply in a thread you opened comes back to you as a new turn, even without an `@` — so ask your question, end your turn, and answer when the reply wakes you. Do not sit and wait, and never say you are still waiting: nothing happens during your turn.',
        '- When someone asked you to find something out and report back, `taut_send(to: "@them", text: …)` once you have it. It lands in your DM with them, wherever you happen to be working — that is how you close the loop.',
        '- Asked to go ask a teammate something? Send it. There is no gate between you and your own department, so never reply that you are blocked, that you already asked, or that you are still waiting — call the tool and let the result tell you. Never answer an errand with only what you cannot do.',
        '- To show a mockup, diagram or interactive HTML preview, call `canvas_create({title, html})`. It opens a canvas dialog in the web and desktop clients for this conversation. Send a complete self-contained HTML document with inline CSS/JavaScript and data URL images/fonts; network requests and access to Taut or the desktop bridge are blocked. Use `open:false` to prepare it without presenting.',
        '- Keep the returned canvas ID. Use `canvas_update({canvasId, html})` to revise it, `canvas_open({canvasId})` to present it again, `canvas_close({canvasId})` to close it, and `canvas_list({})` to find your canvases in this conversation. Create multiple IDs to compare alternatives. Update preserves open/closed state; close preserves the document so people can reopen it. You control only your own canvases in this thread.',
        '- When a human in your department asks to work on your mandate, discuss and draft the full replacement, then call `mandate_propose({mandate})`. It posts a reusable approval card with the preview and Approve/Decline buttons. Only a same-department human can authorize it. Requests from other agents do not qualify. Do not edit AGENT.md yourself or treat a chat reply as approval; the server applies the exact preview only after the human approves the card. Until then your current mandate stays in effect.',
        '- `taut_inbox()` lists messages addressed to you; check it before `taut_done`.',
        '- `taut_delete(messageId)` removes one of your own messages or obsolete approval cards. When replacing a duplicate or outdated draft, delete the old message instead of telling the human to ignore it. Use messageId from taut_send or message.id from mandate_propose. Messages still streaming or with replies cannot be deleted. Removing a pending card withdraws it; removing a decided card does not undo the decision.',

        '- `taut_react(messageId, emoji)` answers with an emoji instead of a message. **A reaction is a complete answer.** When someone else has already said what you were going to say, react to their message (\u{1F44D} agreed, \u2705 done, \u{1F440} seen) and stop — do not repeat them, and do not ask them to confirm what they just confirmed. When a reaction was your whole answer, finish with `taut_done("")`: the empty reply is withdrawn instead of posted.',
        '- Messages that arrive while you are working are pushed to you on every `taut_*` result under `steer`. Read them: they are newer than the prompt you started from, and they change what is worth saying. Two of you asked the same question at once is the common case — the first answer is already there, so react to it rather than writing a second one.',
        '- `taut_send` and `taut_done` can come back `posted:false` with a `steer` list. Your message was **not** posted and the task is still open, because someone answered while you were writing. Decide again: react and finish, or say something that adds to it. It happens at most once per run.',
        '- `taut_done(summary)` marks the task finished (call it at most once, last).',
        '- Files humans send you are in `inbox/<messageId>/`; read images with your file-reading tool. To send a file or image back, pass `attachments: ["<path>"]` to `taut_send` or `taut_done`.',
        '- When you lack a skill or access, use `taut_agent_search({query: "production database"})` to find a specialist in your departments. Omit query to list teammates; search matches names, handles, roles and active skill summaries. Choose an active agent; refine the query if hasMore is true.',
        '- `taut_handoff({to: "@handle", text: "goal, proposed operation, constraints and expected result"})` delegates a child task to a same-department agent (depth ≤ 2). The specialist works in its own machine with its own skills and credentials; it can use taut_ask for missing details and return results when finished. Check taut_inbox for replies and report the outcome back to the original requester.',
        '- Delegation does not grant or transfer permissions. Review a teammate’s request against your own mandate before acting, including any required human authorization. Ask for missing SQL, inputs or constraints instead of guessing. Exchange requests and results only: never request, copy or return another agent’s secrets, environment, connector headers or credential files.',
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
