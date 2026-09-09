# Build plan: message actions (reactions · forward · copy · hover toolbar)

Engineering contract for one owner requirement (2026-09-08 afternoon): **every message gets the
Slack hover toolbar — quick emoji reactions, add reaction, reply in thread, forward, copy, more.**
Extends `docs/build-plan.md`. Effect everywhere, pinned versions from `docs/CHANGELOG.md`
(effect 3.22.1 / platform 0.97.1 / vitest 3.2.7). Migrations are append-only; `0011` and `0012`
are taken by the attachments and routines builds running in parallel — **this build owns `0013`.**

## Owner requirement (verbatim intent)

> "For every message, let's add the same functionality that Slack has of copy the message or
> forward someone else etc emoji reactions" — with a screenshot of Slack's hover bar:
> `✅ 👀 🙌 | add reaction | reply in thread | forward | save | mark unread | remind | more`.

In scope for this pass: **reactions** (quick + picker, chips under the message, live for every
viewer), **forward** to another channel/DM with an optional comment, **copy text**, **copy link**,
and the existing **reply / edit / delete** folded into the same toolbar. Out of scope, recorded as
`// TODO(plan)`: save/bookmark, mark unread, remind me, agents reacting through the MCP tools.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                                                                                                           | why                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Reactions live on the message.** `Message.reactions: ReadonlyArray<Reaction>` where one `Reaction` = one emoji with its count and the members who used it, ordered by the time the emoji was first added. Always an array in memory, absent-or-array on the wire (same trick as `attachments`).                                                                                                                  | One payload, one cache: every existing `message.updated` consumer (thread panel, search focus, streaming) keeps working. |
| D2  | **Table `message_reactions`** (below), PK `(message_id, member_kind, member_id, emoji)`, `ON DELETE CASCADE` from `messages`. `member_kind` is kept so agents can react later without a migration.                                                                                                                                                                                                                 | Idempotent add/remove by construction; deleting a message takes its reactions with it.                                   |
| D3  | **Two endpoints on the messages group**: `PUT /api/messages/:messageId/reactions/:emoji` (add) and `DELETE …/:emoji` (remove). Both idempotent, both return the hydrated `Message`, both emit **`message.updated`** (no new event type). `:emoji` travels URL-encoded.                                                                                                                                             | Reuses the update path end to end; the client cache already replaces by id.                                              |
| D4  | **Who may react**: anyone who can view the channel (`channels.requireView`), including on `failed`/`streaming` messages. Limits: `emoji` is 1–8 code points and not whitespace/ASCII-alnum (`Validation` 422 otherwise); at most **20 distinct emoji per message** (`Validation`); nothing per user.                                                                                                               | Slack's rules, minus custom emoji.                                                                                       |
| D5  | **Forward is client-side quoting**, no new endpoint: `messages.create` in the target channel with body = optional comment, blank line, the original as a `>` blockquote, then a `> — Forwarded from @handle in #channel · [view original](<link>)` line. Attachments are **not** forwarded (`// TODO(plan)`).                                                                                                      | Zero server surface; the quote renders with the existing markdown.                                                       |
| D6  | **Links to a message** (copy link, forward footer): `${origin}/c/<channelId>?at=<messageId>` for channels, `/dm/<channelId>?at=<messageId>` for DMs; a thread reply links to `?thread=<rootId>&at=<messageId>`. The existing `at` search param already scrolls-and-flashes.                                                                                                                                        | Nothing new to route.                                                                                                    |
| D7  | **Toolbar** (replaces the current three-button strip in `message-bubble.tsx`): `✅ 👀 🙌` quick reactions · add reaction (`SmilePlusIcon`, opens the picker) · reply in thread (`MessageSquareIcon`, root messages only) · forward (`ForwardIcon`) · more (`EllipsisVerticalIcon` dropdown: Copy text, Copy link, Edit, Delete). Edit/Delete stay author-or-admin only. Toolbar stays `hidden sm:flex` like today. | Matches the screenshot; keeps the mobile layout untouched.                                                               |
| D8  | **Chips** under the body (below attachments, above the thread footer): one per reaction, `emoji count`, highlighted when the viewer is in it, click toggles, `title` lists names ("You, Ana and 2 others"); a trailing `+` chip opens the picker. Optimistic toggle, reverted on error.                                                                                                                            | Slack's look; the toggle feels instant on the viewer's screen.                                                           |
| D9  | **Picker** = our own `ReactionPicker` (Popover): a "Frequently used" row (last 8, `localStorage` `taut.reactions.recent`), then ~120 curated emoji in 6 groups, filterable by name. No `emoji-mart` (`// TODO(plan): full picker + skin tones`).                                                                                                                                                                   | Self-contained, no bundle cost, deterministic.                                                                           |

## Interfaces every agent must honour

### `@taut/contract`

```ts
// domain/message.ts (owned by this build; keep `attachments` exactly as it is)
export const ReactionMember = Schema.Struct({ kind: MemberKind, id: MemberId })
export class Reaction extends Schema.Class<Reaction>('Reaction')({
  emoji: Schema.String,
  count: Schema.PositiveInt,
  /** Everyone who added it, oldest first. */
  members: Schema.Array(ReactionMember)
}) {}
Message: + reactions: Schema.optionalWith(Schema.Array(Reaction), { default: () => [] })
// domain/index.ts re-exports Reaction / ReactionMember

// api/messages.ts — add to MessagesGroup (keep every existing endpoint untouched)
export const Emoji = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32))   // shape only; semantics = D4 on the server
const ReactionPath = Schema.Struct({ messageId: MessageId, emoji: Emoji })
react:   HttpApiEndpoint.put('react',   '/:messageId/reactions/:emoji').setPath(ReactionPath).addSuccess(Message).addError(NotFound).addError(Forbidden).addError(Validation)
unreact: HttpApiEndpoint.del('unreact', '/:messageId/reactions/:emoji').setPath(ReactionPath).addSuccess(Message).addError(NotFound).addError(Forbidden)
```

No new event type: both endpoints emit `message.updated` with the hydrated message.

### Server (`apps/server`)

- Migration `0013_message_reactions.ts`:
  ```sql
  CREATE TABLE message_reactions (
    message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    member_kind TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (message_id, member_kind, member_id, emoji)
  );
  CREATE INDEX message_reactions_company_message ON message_reactions(company_id, message_id);
  ```
- `services/reactions.ts` — `Reactions` Effect.Service (deps: `SqlClient`, `Channels`,
  `EventPublisher`, `Messages`):
  - `listForMessages(companyId, ids) -> Map<MessageId, ReadonlyArray<Reaction>>` — one query per
    page (`GROUP BY message_id, emoji` for count + `MIN(created_at)` as the order key, plus one
    query for members ordered by `created_at`), never per row.
  - `withReactions(companyId, messages) -> ReadonlyArray<Message>` — the hydration helper
    `services/messages.ts` will call from every read path (`withThreads` for pages,
    `loadMessage` for single messages). **Do not edit `services/messages.ts` in this pass** — it is
    held by two other builds; the orchestrator lands the two call sites after they release it.
  - `add(me, messageId, emoji) -> Message` and `remove(me, messageId, emoji) -> Message`: load
    the message (`Messages.byId`), `channels.load` + `requireView`, validate D4, `INSERT OR IGNORE`
    / `DELETE`, then inside `publisher.transact` re-load through `Messages` (so the payload carries
    thread summary + attachments + reactions) and `emit({ type: 'message.updated', … })`.
    `remove` of a reaction that is not there is a no-op that still returns the message.
  - `isValidEmoji(s: string): boolean` exported for tests: 1–8 code points, no whitespace, no
    ASCII letters/digits, total length ≤ 32.
- `http/messages.ts`: handlers `react` / `unreact` → `Reactions.add` / `Reactions.remove`.
  (`MessagesLive` is already in `http/api.ts`'s group merge, so **no edit to `http/api.ts`**.)
- `layers.ts`: `Reactions.Default` belongs in `DomainTier2` next to `Messages.Default` — **held
  by another build; leave a one-line note in the report and do not edit it.** Until it lands,
  tests can provide `Reactions.Default` on top of `testApp(dir)` themselves.
- Tests: `apps/server/test/reactions.test.ts` — owner reacts ✅ → `messages.list` carries
  `reactions: [{ emoji: '✅', count: 1, members: [owner] }]`; a second member reacts the same emoji
  → count 2, members in order; PUT twice is idempotent; DELETE removes only the caller's; a
  non-member of a private channel gets 403; `'ab'` and `' '` get 422; the 21st distinct emoji gets
  422; the `message.updated` frame arrives on `/ws` with the reactions; deleting the message
  cascades the rows (assert via a raw `SELECT COUNT(*)`). Plus `isValidEmoji` unit cases
  (`'👍'`, `'👍🏽'`, `'👩‍💻'` ok; `'a'`, `'😀😀😀😀😀😀😀😀😀'`, `''` not).

### Web (`apps/web`)

- **Do not edit `lib/api.ts` or `lib/live.ts`** (held by the routines build). New hooks go in
  `lib/message-actions.ts`: `useToggleReaction()` (mutation `{ messageId, emoji, on: boolean }` →
  `api.messages.react` / `unreact`, `onMutate` optimistic edit of the cached `Message.reactions`
  via `updateMessage`, revert `onError`, `onSuccess` replaces with the server message),
  `messageLink(channel: Channel, message: Message): string` (D6), `forwardBody(...)` (D5),
  `useForwardMessage()` (→ `api.messages.create` + `addMessage`), `rememberRecentEmoji` /
  `recentEmoji()` (D9). Import `call` from `@/lib/api-client` and the mutation wrapper from
  wherever `lib/api.ts` gets it (`useEffectMutation`); if it is not exported, add a minimal local
  equivalent rather than editing `api.ts`.
- `components/reaction-picker.tsx`: `ReactionPicker({ onPick, children })` — Popover with a
  search input, recent row, grouped grid (Smileys, Gestures, Hearts, Objects, Symbols, Nature —
  ~20 each, every entry `{ emoji, name }`). Keyboard: arrows move, Enter picks, Esc closes.
- `components/reaction-chips.tsx`: `ReactionChips({ message, onToggle, onAdd })` per D8; who "I"
  am comes from `useMe()`; names from `useLookupMember()`.
- `components/message-actions.tsx`: the D7 toolbar. Props: `message`, `channel` (from
  `useChannels()` by `message.channelId`), `own`, `canEdit`, `onEdit`, `onDelete`, `onOpenThread`,
  `onReact(emoji)`, `onForward()`. Copy uses `navigator.clipboard.writeText` and a `toast('Copied')`.
- `components/forward-dialog.tsx`: `Dialog` with a `Command` list of the channels + DMs the user
  can post to (from `useChannels()`, DMs labelled with the other member's name via
  `useLookupMember`), an optional comment `Textarea`, a preview of the quoted original, and a
  Forward button. On success: toast with a "View" action that navigates to the target channel.
- `components/message-bubble.tsx`: replace the current toolbar block with `<MessageActions>`;
  render `<ReactionChips>` under `<AttachmentList>`. Keep every other behaviour (streaming caret,
  edit box, failed state, thread footer) byte-for-byte.
- `components/message-list.tsx` already passes `own`/`onEdit`/`onDelete`/`onOpenThread`; it does
  not need new props if `MessageActions` reads the channel itself.
- Cache: `lib/message-cache.ts` `appendToMessage` spreads the item, so `reactions` survives
  deltas. Nothing else to change.

### Docs

- `docs/agent-model.md` §12: add the `message_reactions` row to the table block.
- `docs/CHANGELOG.md`: new section at the end **"Message actions (reactions · forward · copy)"** —
  what works, how to try it, the D5/D9 TODOs; one line added to the "Click first" list.

## Verification the final agent runs

1. `pnpm typecheck` and `pnpm test` green across the workspace (other builds are landing in
   parallel — if a failure is in a file this plan does not touch, say so instead of fixing it).
2. Browser pass (Claude in Chrome, `pnpm dev`, seeded owner): hover a message → toolbar shows;
   click ✅ → chip appears with count 1 and highlighted; second browser tab sees it live; click
   the chip → gone; `+` → picker → pick 🎉; ⋮ → Copy link → paste into the composer → send → the
   link opens the channel scrolled to the message; Forward → pick a DM → comment → the quote lands
   there with the footer link.
3. Report: what is verified (test names + what the browser showed), what is not, and any
   deviation from D1–D9.
