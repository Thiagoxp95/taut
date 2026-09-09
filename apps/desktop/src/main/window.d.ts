import { BrowserWindow, type BrowserWindowConstructorOptions, type Session } from 'electron'
/** Cookies (and therefore the login session) survive restarts in this partition. */
export declare const PARTITION = 'persist:taut'
/** The one place the allowlist widens: the configured instance (+ the dev server). */
export declare const setAllowedOrigins: (origins: readonly string[]) => void
export declare const allowMediaOrigin: (raw: string) => void
/** Test seam: the shell never clears these itself, a restart does. */
export declare const clearMediaOrigins: () => void
export declare const isAllowed: (raw: string, resourceType?: string) => boolean
/**
 * Default-deny for the whole partition: a Taut window may talk to its own
 * instance and to nothing else, so a compromised page cannot exfiltrate the
 * session cookie by loading an off-origin image or opening a socket. The one
 * exception is a media origin the page named through the bridge, and that one
 * is narrowed to signalling and media traffic (`allowMediaOrigin`).
 */
export declare const installRequestFilter: (session: Session) => void
/**
 * Screen share inside the shell (docs/build-plan-calls.md). Electron gives `getDisplayMedia`
 * no picker of its own: without a handler the promise rejects with nothing to show for it and
 * the share button in the huddle bar looks broken. This grants the first screen, which is the
 * whole-desktop case Slack huddles start from.
 *
 * // TODO(plan) a source picker (windows and tabs, not just screens) and `audio: 'loopback'`,
 * which needs a per-platform capture path rather than one flag.
 */
export declare const installDisplayMediaHandler: (session: Session) => void
/**
 * Chrome every window the shell owns shares. Split out of `createWindow` because the huddle
 * window is built elsewhere (`main/huddle.ts`, docs/build-plan-huddle-window.md D13) and must
 * not drift from the main window's hardening — a second window on the same partition carries
 * the same login cookie, so it has to carry the same guards.
 */
export declare const shellWebPreferences: (
  preload: 'index' | 'setup' | 'huddle'
) => BrowserWindowConstructorOptions['webPreferences']
/** `hiddenInset` on macOS; the web layout pads itself when `window.taut` exists. */
export declare const shellChrome: () => BrowserWindowConstructorOptions
export declare const installNavigationGuards: (window: BrowserWindow) => void
export interface WindowOptions {
  /** `index` for the instance window, `setup` for the Connect screen. */
  readonly preload: 'index' | 'setup'
  readonly onNavigateExternal?: (url: string) => void
}
export declare const createWindow: (options: WindowOptions) => BrowserWindow
