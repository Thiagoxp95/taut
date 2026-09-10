/**
 * The Electron shell ↔ web app boundary.
 *
 * `apps/desktop/src/preload` implements it; `apps/web` feature-detects it
 * (`window.taut !== undefined` means "running inside the desktop shell").
 * It lives here because it is the one contract both sides must agree on, and
 * because `apps/web` must not take a dependency on the Electron package.
 *
 * Plain TypeScript on purpose: it crosses `contextBridge`, which only carries
 * structured-cloneable values and functions — no `Schema` decoding involved.
 */

/** Where the OS notification (or a `taut://` deep link) wants the app to go. */
export type DesktopNavigateHandler = (path: string) => void

export type DesktopUpdateState =
  | { readonly status: 'idle' | 'disabled' | 'checking' | 'current'; readonly version: string }
  | { readonly status: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly status: 'ready' | 'restarting'; readonly version: string }
  | { readonly status: 'error'; readonly version: string; readonly message: string }

export interface DesktopUpdateBridge {
  readonly state: () => Promise<DesktopUpdateState>
  readonly check: () => Promise<void>
  readonly restart: () => Promise<void>
  readonly onState: (handler: (state: DesktopUpdateState) => void) => () => void
}

export interface ClaudeDesktopLogin {
  readonly kind: 'claude.login'
  readonly secret: string
}

/** Fixed loopback port for a browser's one-use handoff to Taut desktop. */
export const CLAUDE_LOGIN_PORT = 45173

export interface DesktopNotification {
  readonly title: string
  readonly body: string
  /** Clicking the OS notification routes to this channel, when given. */
  readonly channelId?: string
}

export interface TautBridge {
  /** Open the shell's server picker. Optional for older shells; absent in huddle windows. */
  readonly changeServer?: () => void
  /** Optional for older shells and intentionally absent in huddle windows. */
  readonly updates?: DesktopUpdateBridge
  /** `process.platform` of the shell — `darwin`, `win32`, `linux`. */
  readonly platform: string
  /** The desktop app's own version (`apps/desktop/package.json`). */
  readonly version: string
  readonly connectClaude: () => Promise<ClaudeDesktopLogin>
  readonly cancelClaudeConnect: () => void
  /** Dock / taskbar badge. `0` clears it. */
  readonly setBadge: (count: number) => void
  /** Ask the shell for an OS notification (the shell raises its own too). */
  readonly notify: (notification: DesktopNotification) => void
  /** Subscribe to shell-driven navigation. Returns an unsubscribe function. */
  readonly onNavigate: (handler: DesktopNavigateHandler) => () => void
  /**
   * Let the shell reach one media server (docs/build-plan-calls.md). A self-hosted LiveKit
   * usually lives on its own host, and the shell is default-deny per origin, so its signalling
   * socket dies unless the page names it — and only the page knows the URL, since it arrives
   * with the join credentials.
   *
   * The shell narrows what this buys: the named origin may carry WebSocket, XHR and media
   * traffic and nothing else, so this cannot be used to load an off-origin image or script.
   * Call it with the `url` from `CallCredentials` before connecting.
   */
  readonly allowMediaOrigin: (url: string) => void
  /**
   * Open the shell's huddle window on an in-app path — `/huddle/<channelId>?mic=1&cam=0`
   * (docs/build-plan-huddle-window.md D6). There is one such window at a time: a second call
   * re-points and focuses the one already open rather than making another (D13).
   *
   * The window, not the page that asked for it, holds the LiveKit room. A main window that
   * calls this must not connect itself, or the same person is in the room twice.
   */
  readonly openHuddle: (path: string) => void
  /** Close the huddle window. The window itself calls this when the user leaves the huddle. */
  readonly closeHuddle: () => void
  /** Bring the main window forward — "back to Taut" from inside the huddle window. */
  readonly focusMain: () => void
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    readonly taut?: TautBridge
  }
}
