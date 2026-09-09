/**
 * What the message toolbar calls (docs/build-plan-message-actions.md).
 *
 * `lib/api.ts` is held by another build, so reactions and forwarding live here.
 * Same bridge (`call` + `useEffectMutation`), same cache helpers.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Channel, ChannelId, MessageId } from '@taut/contract'
import { Message, Reaction } from '@taut/contract'

import { useMe } from '@/lib/api'
import { call } from '@/lib/api-client'
import { addMessage, updateMessage, type MessagePages } from '@/lib/message-cache'
import { qk } from '@/lib/query-keys'
import { useEffectMutation } from '@/lib/runtime'

type ReactionMember = Reaction['members'][number]

/** Is the signed-in user on this emoji? Drives the chip highlight and the toggle direction. */
export const reactedByMe = (reaction: Reaction, userId: string | undefined): boolean =>
  reaction.members.some((member) => member.kind === 'user' && member.id === userId)

/** The optimistic edit needs the message that is on screen, wherever it is cached. */
function findMessage(queryClient: QueryClient, messageId: string): Message | undefined {
  for (const queryKey of [qk.allMessages, qk.allThreads]) {
    for (const [, data] of queryClient.getQueriesData<MessagePages>({ queryKey })) {
      for (const page of data?.pages ?? []) {
        const found = page.items.find((item) => item.id === messageId)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

/** D8: what the chips show the moment the viewer clicks, before the server answers. */
function toggled(
  reactions: readonly Reaction[],
  emoji: string,
  me: ReactionMember,
  on: boolean
): readonly Reaction[] {
  const isMe = (member: ReactionMember): boolean => member.kind === me.kind && member.id === me.id
  const current = reactions.find((reaction) => reaction.emoji === emoji)

  if (on) {
    if (current === undefined) {
      return [...reactions, new Reaction({ emoji, count: 1, members: [me] }, true)]
    }
    if (current.members.some(isMe)) return reactions
    return reactions.map((reaction) =>
      reaction === current
        ? new Reaction(
            { emoji, count: reaction.count + 1, members: [...reaction.members, me] },
            true
          )
        : reaction
    )
  }

  if (current === undefined || !current.members.some(isMe)) return reactions
  if (current.count <= 1) return reactions.filter((reaction) => reaction !== current)
  return reactions.map((reaction) =>
    reaction === current
      ? new Reaction(
          {
            emoji,
            count: reaction.count - 1,
            members: reaction.members.filter((member) => !isMe(member))
          },
          true
        )
      : reaction
  )
}

export interface ToggleReactionInput {
  readonly messageId: MessageId
  readonly emoji: string
  /** `true` puts the viewer on the emoji, `false` takes them off it. */
  readonly on: boolean
}

/** Both endpoints are idempotent and return the hydrated message (D3). */
export function useToggleReaction() {
  const queryClient = useQueryClient()
  const me = useMe().data

  return useEffectMutation(
    (input: ToggleReactionInput) =>
      input.on
        ? call((api) =>
            api.messages.react({ path: { messageId: input.messageId, emoji: input.emoji } })
          )
        : call((api) =>
            api.messages.unreact({ path: { messageId: input.messageId, emoji: input.emoji } })
          ),
    {
      onMutate: (input) => {
        const previous = findMessage(queryClient, input.messageId)
        if (previous === undefined || me === undefined) return undefined
        const reactions = toggled(
          previous.reactions,
          input.emoji,
          { kind: 'user', id: me.user.id },
          input.on
        )
        updateMessage(queryClient, new Message({ ...previous, reactions }, true))
        return previous
      },
      // The mutation context is `unknown` through `useEffectMutation`; the class narrows it.
      onError: (_error, _input, previous) => {
        if (previous instanceof Message) updateMessage(queryClient, previous)
      },
      onSuccess: (message) => updateMessage(queryClient, message)
    }
  )
}

/** D6: `at` already scrolls-and-flashes on both channel routes; a reply carries its thread. */
export function messageLink(channel: Channel, message: Message): string {
  const path = `${channel.kind === 'dm' ? '/dm' : '/c'}/${channel.id}`
  const search =
    message.threadId === undefined
      ? `?at=${message.id}`
      : `?thread=${message.threadId}&at=${message.id}`
  return `${window.location.origin}${path}${search}`
}

export interface ForwardOrigin {
  readonly message: Message
  /** The original author's handle, without the `@`. */
  readonly handle: string
  /** Where it was said: `#general`, or `@ana` for a DM. */
  readonly source: string
  readonly link: string
}

/**
 * D5: forwarding is client-side quoting — the comment, then the original as a
 * blockquote, then the attribution line. Attachments do not travel.
 */
export function forwardBody(comment: string, origin: ForwardOrigin): string {
  const footer = `> — Forwarded from @${origin.handle} in ${origin.source} · [view original](${origin.link})`
  const quoted = origin.message.body
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
  const body = origin.message.body.trim() === '' ? footer : `${quoted}\n${footer}`
  const note = comment.trim()
  return note === '' ? body : `${note}\n\n${body}`
}

export function useForwardMessage() {
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { channelId: ChannelId; body: string }) =>
      call((api) =>
        api.messages.create({ payload: { channelId: input.channelId, body: input.body } })
      ),
    { onSuccess: (message) => addMessage(queryClient, message) }
  )
}

// --- frequently used (D9) -------------------------------------------------

const RECENT_KEY = 'taut.reactions.recent'
const RECENT_MAX = 8

export function recentEmoji(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const entry of parsed) if (typeof entry === 'string') out.push(entry)
    return out.slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

export function rememberRecentEmoji(emoji: string): void {
  const next = [emoji, ...recentEmoji().filter((entry) => entry !== emoji)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* private mode — the row stays empty */
  }
}
