/**
 * Running inside the Electron shell (`apps/desktop`)? The preload exposes
 * `window.taut`; the type comes from `@taut/contract/desktop`, which is the
 * only thing the shell and the web client share.
 */
import type { TautBridge } from '@taut/contract/desktop'

import { leaveSoundDelay } from '@/lib/sounds'

export const desktop: TautBridge | undefined =
  typeof window === 'undefined' ? undefined : window.taut

/** The shell raises OS notifications, so the in-app toast would be a duplicate. */
export const isDesktop = desktop !== undefined

/** Where the shell's huddle window lives (docs/build-plan-huddle-window.md D6). */
export const HUDDLE_PATH = '/huddle/'

/** The in-app path `openHuddle` is handed, intent and all. */
export const huddlePath = (channelId: string, intent: { mic: boolean; camera: boolean }): string =>
  `${HUDDLE_PATH}${channelId}?mic=${intent.mic ? '1' : '0'}&cam=${intent.camera ? '1' : '0'}`

/**
 * The two shell windows are told apart by the route they are showing, not by a bridge member
 * (D6): only the huddle window ever renders `/huddle/…`, and the main window never navigates
 * there — it opens the second window instead. Read at call time, because a renderer can be
 * pointed at a different huddle while it is running (D13).
 */
export const isHuddleWindow = (): boolean =>
  typeof window !== 'undefined' && window.location.pathname.startsWith(HUDDLE_PATH)

/**
 * `true` in the shell's main window, where a huddle must be delegated rather than connected —
 * two renderers in one room is two microphones (D6). A plain browser stays in-page (D5), so
 * this is false there however many tabs are open.
 */
export const delegatesHuddle = (): boolean => isDesktop && !isHuddleWindow()

/**
 * Close the shell's huddle window once your own pop-out has been heard.
 *
 * Leaving plays the sound and closes the window in the same beat, and the window is the thing
 * playing it — `close()` on the spot would cut it off. The wait is the audible length of the
 * clip, and nothing at all when sounds are muted or never unlocked.
 */
export const closeHuddleWindow = (): void => {
  const delay = leaveSoundDelay()
  if (delay === 0) {
    desktop?.closeHuddle()
    return
  }
  window.setTimeout(() => desktop?.closeHuddle(), delay)
}
