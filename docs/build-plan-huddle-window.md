# Build plan: huddle window — pre-join dialog, its own window, a huddle thread, sounds

Engineering contract for one owner requirement (2026-09-09): **the Slack mechanism around a
huddle**, not just the huddle itself — _"a popup appears to begin the huddle and once started a
new window electron is opened with a thread for the huddle"_. Plus two sounds the owner supplied:
a pop for message notifications, an alert for a huddle invite.

Extends `docs/build-plan-calls.md` (D1–D16 there still hold except where **D8 below amends its
D7**). Effect everywhere, pinned versions from `docs/CHANGELOG.md`
(effect 3.22.1 / platform 0.97.1 / vitest 3.2.7 / livekit-client 2.22.3 / livekit-server-sdk 2.19.0).

**No new migration.** `calls.summary_message_id` already exists; its meaning widens (D8).

## Scope

**In:** a pre-join dialog with a live self-preview and device pickers; a dedicated Electron
window that owns the room; a real message thread per huddle; a notification pop sound; a ringing
alert on an incoming DM huddle with Join / Decline.

**Out, recorded as `// TODO(plan)`:** a screen-share source picker, ringing for channel huddles,
a server-side "declined" state, per-huddle emoji reactions, speaker view, recording.

## Owner decisions taken before writing this (2026-09-09)

Asked and answered: the huddle thread is backed by a **message posted at start** and edited on
end; a plain **browser stays in-page** (no popup window) and only the Electron shell opens a
second window.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #    | decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | **The pre-join dialog is the only way into a huddle.** `HuddleButton` no longer joins; it opens `HuddlePrejoin`. Nothing reaches the server until **Start Huddle** is pressed — Cancel costs a `getUserMedia` and nothing else. Header reads `Start huddle in # name` when no call is open and `Join huddle in # name` when one is.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D2   | **The self-preview is live whenever the camera is available**, exactly like the reference screenshot, and the camera toggle decides only what gets _published_ on join. A denied or missing camera is not an error: the preview becomes the member's avatar on a muted ground with one line of explanation, and the dialog still starts a huddle.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D3   | **Device choice is per-browser, not per-call.** `{ micId, speakerId, cameraId }` in `localStorage` under `taut.huddle.devices`, written by the dialog and read by whatever joins. Applied to LiveKit through capture defaults; the speaker through `setSinkId` on the attached audio elements, silently ignored where the browser has no such thing (Safari, Firefox).                                                                                                                                                                                                                                                                                                                                                                                                 |
| D4   | **One component tree, two mounts.** `huddle-room.tsx` renders tiles + controls + the huddle thread. `_app.tsx` mounts it inline (browser, D5) and the route `/huddle/$channelId` mounts it as the whole page (the shell's window). No branch inside the room itself beyond a `layout` prop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D5   | **A plain browser stays in-page.** After the dialog, the browser joins where it stands: today's `HuddleBar` plus the room panel above it. `window.open` is not used — popup blockers and a second connection lifecycle buy nothing here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D6   | **Inside the shell, the huddle window owns the room; the main window never connects.** The dialog in the main window calls `window.taut.openHuddle('/huddle/<channelId>?mic=1&cam=0')` and stops. The huddle window does the `join` request and the LiveKit connect. Two renderers, one connection, no way to end up with two microphones.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D7   | **The main window keeps a "Return to huddle" bar**, driven by `useActiveCalls` — the server already knows this user is a participant (calls D2), so the main window needs no room of its own to render presence. Its button focuses the huddle window; leaving is done in the window that is actually in the call.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D8   | **The huddle message is posted at start, not at end** — this amends `docs/build-plan-calls.md` D7. On `call.started` the server posts `🎧 Huddle in #general` authored by whoever started it and stores its id in `calls.summary_message_id`; on `room_finished` it **edits that same message** to `🎧 Huddle · 12 min · Ana, Bruno`. One message per huddle either way, and the thread under it is where everything said in the huddle lives.                                                                                                                                                                                                                                                                                                                         |
| D9   | **The huddle chat is that message's thread.** The room panel renders `useThread(call.messageId)` with the ordinary `MessageList` and `Composer`, posting with `threadId`. No new endpoint, no new message kind, and the channel shows the huddle and its replies in normal history. A huddle whose message could not be posted (archived channel, starter removed) still runs; the panel says chat is unavailable.                                                                                                                                                                                                                                                                                                                                                     |
| D10  | **Sounds are one module, `lib/sounds.ts`.** `pop` for a notification addressed to this user, `ring` (looping) while a DM huddle invite is pending. Both are unlocked on the first user gesture — browsers refuse audio before one — and both respect a `taut.sounds.muted` flag in `localStorage`. Never play a sound for something this user did.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D11  | **An incoming DM huddle rings with Join / Decline.** `call.started` on a DM this user is in, and is not already in, raises an invite card and starts `ring`. Decline is local: it stops the ring and hides the card for that call id. There is no declined state on the server (`// TODO(plan)`) — the caller sees nobody joined, which is what a missed call looks like anyway. Channel huddles stay silent (calls D8).                                                                                                                                                                                                                                                                                                                                               |
| D12  | **Three bridge members, no more:** `openHuddle(path)`, `closeHuddle()`, `focusMain()`. The shell decides window geometry and lifetime; the page decides nothing about Electron.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D13  | **One huddle window at a time.** A second `openHuddle` navigates and focuses the existing one rather than opening another. Closing the window is a hard leave — the renderer unloads, LiveKit disconnects, and the webhook settles the truth a moment later (calls D2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D14a | **Four sounds, not two** (owner, 2026-09-09). `pop.mp3` a notification for you; `ring.mp3` a DM huddle invite; **`pop-in.mp3` somebody joining a huddle you are in, `pop-out.mp3` somebody leaving it.** Remote arrivals and departures come from the participant list on the `RoomSnapshot`, diffed by identity and seeded on first connect — arriving in a room of five must not play five pops.                                                                                                                                                                                                                                                                                                                                                                     |
| D14b | **The pops are for you too** (owner, 2026-09-09, revising D14a). Starting a huddle, joining one and leaving one each play the same pop-in / pop-out for the person doing it — not only for the people already in the room. Your own two are played by `HuddleProvider` where they happen (`join` after the room connects, `detach` and the unasked-for-drop handler before it tears down), never by the roster diff, so a join is one pop and not two. In the shell that is always the huddle window and never the main one (D6): it arms the sounds itself because it is not under `_app`, it unlocks without a gesture because Electron does not gate autoplay, and its close waits out the audible length of `pop-out.mp3` so leaving is heard rather than cut off. |
| D14  | **No migration.** `summary_message_id` keeps its name; a rename in SQLite is a table rebuild and the column already means "the message for this huddle".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Interfaces every agent must honour

These are written by the orchestrator **before** the agents start. Do not edit
`packages/contract` — read it.

### `@taut/contract` — `domain/call.ts`

```ts
export class Call extends Schema.Class<Call>('Call')({
  // …unchanged…
  /**
   * The channel message that stands for this huddle (D8): posted when the call opens,
   * edited to the summary when it closes. Its thread is the huddle chat (D9). Absent only
   * when posting failed.
   */
  messageId: Schema.optional(MessageId),
  participants: Schema.optionalWith(Schema.Array(CallParticipant), { default: () => [] })
}) {}
```

### `@taut/contract` — `desktop.ts`

```ts
export interface TautBridge {
  // …unchanged…
  /** Open (or focus and re-point) the shell's huddle window at an in-app path (D6, D13). */
  readonly openHuddle: (path: string) => void
  /** Close the huddle window. Called by the window itself when the user leaves (D13). */
  readonly closeHuddle: () => void
  /** Bring the main window forward — "back to Taut" from inside the huddle window. */
  readonly focusMain: () => void
}
```

## Work split

Three agents, disjoint directories, all against this doc.

### Agent SERVER — `apps/server`

1. `services/calls.ts`: post the huddle message inside `join` when `started` is true, right
   after `call.started` is emitted, and store its id. Reuse `messages.postAsUser`; a failure is
   a warning, never a failed join. Body: `🎧 Huddle in #<name>` for a channel, `🎧 Huddle` for a
   DM.
2. `services/messages.ts`: add `editAsSystem(companyId, messageId, body)` — `updateBody` plus a
   `message.updated` emit, no actor, for the end-of-call rewrite. Keep `edit` untouched.
3. `summarise` now edits rather than posts: load `summary_message_id`, call `editAsSystem` with
   `🎧 Huddle · 12 min · Ana, Bruno`. If the id is absent (posting failed at start) fall back to
   posting, exactly as today.
4. `domain/rows.ts`: `toCall` carries `messageId` from `summary_message_id`.
5. Tests in `test/calls.test.ts`: a huddle posts one message on start; ending edits that same
   message; a second `room_finished` edits nothing twice; a failed post still joins.

### Agent WEB — `apps/web`, `packages/ui`

1. `components/huddle-prejoin.tsx` — the dialog (D1, D2, D3). Live preview, mic/camera toggles
   over the preview, three device selects, Cancel and Start Huddle. Match the reference:
   header, preview, a row of three device pickers, two large buttons at the bottom.
2. `lib/devices.ts` — enumerate devices, persist the choice, hand LiveKit its capture defaults.
   `lib/livekit.ts` gains `setDevices` and applies `setSinkId` to attached audio.
3. `components/huddle-room.tsx` — tiles + controls + thread panel (D4, D9). `huddle-tiles.tsx`
   folds into it or is reused as-is; `huddle-bar.tsx` keeps the docked strip.
4. `routes/huddle.$channelId.tsx` — top-level, auth-gated like `_app`, no sidebar, its own
   `HuddleProvider`, reads `?mic=&cam=` and joins on mount (D5, D6).
5. `hooks/use-huddle.ts` — `join` takes an intent `{ mic, camera }`; inside the shell's **main**
   window it delegates to `window.taut.openHuddle` instead of connecting (D6); the main window
   renders "Return to huddle" from `useActiveCalls` (D7).
6. `lib/sounds.ts` + wiring — pop on a notification for this user, ring on a DM huddle invite,
   an invite card with Join / Decline, and pop-in / pop-out as people come and go, yourself
   included (D10, D11, D14a, D14b). All four files are already in `apps/web/public/sounds/`:
   `pop.mp3`, `ring.mp3`, `pop-in.mp3`, `pop-out.mp3`.

### Agent DESKTOP — `apps/desktop`

1. `main/huddle.ts` — create/focus/close the single huddle window (D13): 480×720, min 400×560,
   `minimizable`, resizable, same `PARTITION`, `preload/huddle.js`, loads
   `<instanceUrl><path>`. It inherits the request filter and the display-media handler because
   it shares the partition.
2. `preload/huddle.ts` — the same bridge surface as `preload/index.ts`.
3. `main/index.ts` — IPC for `taut:huddle:open` / `close` / `focus-main`; remember the instance
   URL so the window can be pointed at it; close the huddle window when the instance changes or
   the app quits.
4. `electron.vite.config.ts` — the new preload entry.

## Definition of done

`pnpm lint && pnpm typecheck && pnpm test` clean at the root. The dialog opens over a channel,
the shell opens a window, the window shows the room and the thread, closing it leaves. No
LiveKit server is available in this environment, so a real room is still unverified — say so
rather than claiming a call was made.
