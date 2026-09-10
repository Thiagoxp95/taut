/**
 * Frames on the terminal socket, `/ws/terminal?agentId=…&cols=…&rows=…`
 * (docs/build-plan-workspace.md D6, D7). A second WebSocket path on purpose:
 * `/ws` has a 64 KB payload cap, a typing-drop heuristic and a slow-client close
 * policy tuned for events, and PTY traffic would trip all three.
 *
 * The same socket carries the browser live view (D11) and its take-control input
 * (D12): `frame` is one JPEG of the agent's browser, `input` one mouse/key event
 * from the viewer holding control, `control` the hand-over both ways.
 *
 * Every `data` field is **base64**: a PTY emits raw bytes, and a UTF-8 multi-byte
 * sequence split across two chunks corrupts if it travels as a text field.
 *
 * `input` frames are never logged, persisted or echoed anywhere (D17): the owner
 * will type real passwords through them.
 */
import { Schema } from 'effect'

import { UserId } from './ids.js'

export const TERMINAL_WS_PATH = '/ws/terminal'

/** Standard base64 (`+`, `/`, `=` padding), the alphabet `Buffer`/`btoa` produce. */
export const Base64 = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
  Schema.annotations({ identifier: 'Base64' })
)

/** xterm.js never asks for less than 1 column; 500 × 500 is far past any monitor. */
export const TerminalDimension = Schema.Int.pipe(Schema.between(1, 500))

// --- browser input (D12) ---------------------------------------------------

/** A coordinate as a fraction of the frame (0 = left/top edge, 1 = right/bottom). */
const Unit = Schema.Number.pipe(Schema.between(0, 1))
/** CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const Modifiers = Schema.Int.pipe(Schema.between(0, 15))

/**
 * One pointer event, in frame-relative coordinates: the server scales them to the
 * page's CSS pixels from the screencast metadata, so the client never needs to know
 * the viewport size. Mirrors the subset of CDP `Input.dispatchMouseEvent` Taut is
 * willing to forward — nothing else in CDP is reachable from a client.
 */
export const BrowserMouseEvent = Schema.TaggedStruct('mouse', {
  type: Schema.Literal('mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'),
  x: Unit,
  y: Unit,
  button: Schema.optional(Schema.Literal('none', 'left', 'middle', 'right')),
  clickCount: Schema.optional(Schema.Int.pipe(Schema.between(0, 3))),
  /** Wheel deltas in CSS pixels. */
  deltaX: Schema.optional(Schema.Number.pipe(Schema.between(-10_000, 10_000))),
  deltaY: Schema.optional(Schema.Number.pipe(Schema.between(-10_000, 10_000))),
  modifiers: Schema.optional(Modifiers)
})

/** One key event; the subset of CDP `Input.dispatchKeyEvent` Taut forwards. */
export const BrowserKeyEvent = Schema.TaggedStruct('key', {
  type: Schema.Literal('keyDown', 'keyUp', 'char'),
  key: Schema.String.pipe(Schema.maxLength(32)),
  code: Schema.String.pipe(Schema.maxLength(32)),
  /** The text a `keyDown` inserts (printable keys), or the `char` payload. */
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(16))),
  keyCode: Schema.optional(Schema.Int.pipe(Schema.between(0, 255))),
  modifiers: Schema.optional(Modifiers)
})

export const BrowserInputEvent = Schema.Union(BrowserMouseEvent, BrowserKeyEvent)
export type BrowserInputEvent = typeof BrowserInputEvent.Type

// --- client → server -------------------------------------------------------

export const TerminalStdin = Schema.TaggedStruct('stdin', { data: Base64 })
export const TerminalResize = Schema.TaggedStruct('resize', {
  cols: TerminalDimension,
  rows: TerminalDimension
})
/** Only honoured while this viewer holds control (D12); silently dropped otherwise. */
export const TerminalInput = Schema.TaggedStruct('input', { event: BrowserInputEvent })
/**
 * Take (`hold: true`) or release (`hold: false`) control of the browser. When the agent
 * has a running task, taking control is refused unless `pause` is `true` — the viewer
 * confirmed "Pause agent & take control" and the runtime is frozen for the duration (D15).
 */
export const TerminalControl = Schema.TaggedStruct('control', {
  hold: Schema.Boolean,
  pause: Schema.optional(Schema.Boolean)
})

/** Browser viewport in CSS pixels, independent of terminal rows/columns. */
export const BrowserViewport = Schema.Struct({
  width: Schema.Int.pipe(Schema.between(1, 4096)),
  height: Schema.Int.pipe(Schema.between(1, 4096))
})
export type BrowserViewport = typeof BrowserViewport.Type
export const TerminalViewport = Schema.TaggedStruct('viewport', BrowserViewport.fields)

export const TerminalClientFrame = Schema.Union(
  TerminalStdin,
  TerminalResize,
  TerminalViewport,
  TerminalInput,
  TerminalControl
)
export type TerminalClientFrame = typeof TerminalClientFrame.Type

// --- server → client -------------------------------------------------------

/** First frame after the shell is up. */
export const TerminalReady = Schema.TaggedStruct('ready', {
  shell: Schema.String,
  machineId: Schema.String
})
export const TerminalData = Schema.TaggedStruct('data', { data: Base64 })
export const TerminalExit = Schema.TaggedStruct('exit', { exitCode: Schema.Int })
/** Human-readable; shown in the terminal before the socket closes. */
export const TerminalError = Schema.TaggedStruct('error', { message: Schema.String })
/** One JPEG of the agent's browser (D11); `width`/`height` are the page's CSS viewport. */
export const TerminalBrowserFrame = Schema.TaggedStruct('frame', {
  data: Base64,
  width: Schema.Int,
  height: Schema.Int
})
/** The browser's open pages and the page currently shown by the live view. */
export const TerminalBrowserTabs = Schema.TaggedStruct('tabs', {
  tabs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      url: Schema.String
    })
  ),
  activeTabId: Schema.NullOr(Schema.String)
})
export type TerminalBrowserTabs = typeof TerminalBrowserTabs.Type

/**
 * Who drives the browser right now: `holder` is the viewer holding control (`null` =
 * nobody, the agent's own tools drive), `paused` whether the agent's runtime is frozen
 * for it (D15). `reason` explains a refused or ended hold.
 */
export const TerminalControlState = Schema.TaggedStruct('control', {
  /** This socket owns the hold; another view of the same user does not. */
  owned: Schema.optional(Schema.Boolean),
  holder: Schema.NullOr(UserId),
  paused: Schema.Boolean,
  reason: Schema.optional(Schema.String)
})
/**
 * State of the live view for this socket: `off` (the agent has no `browserAccess`,
 * D16), `starting` (Chromium is being brought up in the box), `live` (frames follow),
 * `unavailable` (no box, `local` provider, or Chromium refused — see `reason`).
 */
export const TerminalBrowserState = Schema.TaggedStruct('browser', {
  state: Schema.Literal('off', 'starting', 'live', 'unavailable'),
  reason: Schema.optional(Schema.String)
})

export const TerminalServerFrame = Schema.Union(
  TerminalReady,
  TerminalData,
  TerminalExit,
  TerminalError,
  TerminalBrowserFrame,
  TerminalBrowserTabs,
  TerminalControlState,
  TerminalBrowserState
)
export type TerminalServerFrame = typeof TerminalServerFrame.Type

/**
 * Close codes the server uses on `/ws/terminal`, in the application range so a
 * client can tell "you were idle" from "the shell exited" without parsing text.
 */
export const TERMINAL_CLOSE = {
  /** The shell exited on its own; an `exit` frame precedes it. */
  exited: 1000,
  /** This viewer already has a terminal open on this agent (D10). */
  viewerBusy: 4409,
  /** The agent already has the maximum number of terminals open (D10). */
  agentFull: 4429,
  /** No input or output for the idle limit (D10). */
  idle: 4408,
  /** The hard session cap was reached (D10). */
  sessionCap: 4410,
  /** The box refused (provider down, container stopped, `local` provider). */
  unavailable: 4503,
  /** The viewer's socket fell too far behind. */
  slowClient: 1013
} as const
