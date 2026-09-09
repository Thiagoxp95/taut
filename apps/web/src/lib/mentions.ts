/**
 * Where `@handle` is found in plain text. One pattern, two readers: the message
 * renderer (`lib/remark-mentions.ts`) and the composer's highlight backdrop
 * (`components/composer.tsx`), so the chip a draft shows is the chip the sent
 * message draws.
 *
 * It mirrors `parseHandles` on the server (apps/server/src/services/messages.ts):
 * a handle starts with an alphanumeric, may contain `.`, `_` and `-`, and must
 * not be preceded by a word character or another `@` — so `user@example.com` is
 * an address, not a mention.
 */
const MENTION = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g

/** Trailing `.`/`_`/`-` belong to the sentence, not to the handle. */
export const trimHandle = (handle: string): string => handle.replace(/[._-]+$/, '')

/** A run of plain text, or one `@handle` (`text` includes the `@`). */
export interface MentionSegment {
  readonly text: string
  readonly handle?: string
}

/**
 * `value` split into plain runs and mentions, in order and lossless: joining
 * every `text` back together returns `value` unchanged.
 */
export function mentionSegments(value: string): readonly MentionSegment[] {
  const parts: MentionSegment[] = []
  let cursor = 0
  MENTION.lastIndex = 0

  for (const match of value.matchAll(MENTION)) {
    const lead = match[1] ?? ''
    const raw = match[2]
    if (raw === undefined) continue
    const handle = trimHandle(raw)
    if (handle === '') continue

    const at = (match.index ?? 0) + lead.length
    if (at > cursor) parts.push({ text: value.slice(cursor, at) })
    parts.push({ text: `@${handle}`, handle })
    cursor = at + 1 + handle.length
  }

  if (parts.length === 0) return [{ text: value }]
  if (cursor < value.length) parts.push({ text: value.slice(cursor) })
  return parts
}
