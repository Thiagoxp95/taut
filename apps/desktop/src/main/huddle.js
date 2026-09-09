import { BrowserWindow } from 'electron'
import { installNavigationGuards, shellChrome, shellWebPreferences } from './window'
/**
 * The shell's huddle window (docs/build-plan-huddle-window.md D6, D13). It, and never the main
 * window, holds the LiveKit room — two renderers connecting to one room would put the same
 * person in it twice, with two microphones.
 *
 * There is exactly one at a time (D13): a second `openHuddle` re-points and focuses this one.
 * Tall and narrow because it is a call strip plus the huddle thread (D9), not a chat client.
 */
const WIDTH = 480
const HEIGHT = 720
const MIN_WIDTH = 400
const MIN_HEIGHT = 560
let huddleWindow = null
/** What the window is pointed at, so a repeat `openHuddle` does not reload a live room. */
let huddleUrl
const alive = () => (huddleWindow !== null && !huddleWindow.isDestroyed() ? huddleWindow : null)
const focus = (window) => {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
const create = () => {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    resizable: true,
    minimizable: true,
    show: false,
    ...shellChrome(),
    // Same partition as the main window, so it arrives already logged in and inherits the
    // default-deny request filter and the display-media handler installed on that session.
    webPreferences: shellWebPreferences('huddle')
  })
  window.on('ready-to-show', () => window.show())
  installNavigationGuards(window)
  window.on('closed', () => {
    huddleWindow = null
    huddleUrl = undefined
  })
  return window
}
/**
 * Open the huddle window on `<instanceUrl><path>`, or re-point and focus the one already open.
 * The instance URL comes from the caller because only `main/index.ts` knows which instance the
 * shell is currently attached to.
 */
export const openHuddle = (instanceUrl, path) => {
  const url = `${instanceUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
  const existing = alive()
  if (existing !== null) {
    // "Return to huddle" (D7) sends the same path the window is already on; reloading it would
    // tear down the LiveKit connection and rejoin, which is exactly what the user did not ask
    // for. Only a genuinely different huddle navigates.
    if (huddleUrl !== url) {
      huddleUrl = url
      void existing.loadURL(url)
    }
    focus(existing)
    return
  }
  huddleWindow = create()
  huddleUrl = url
  void huddleWindow.loadURL(url)
}
/**
 * Closing the window is a hard leave (D13): the page's unload handler disconnects LiveKit and
 * the webhook settles the truth a moment later, so the shell never calls the API itself. That
 * is also why this closes rather than destroys — `destroy()` would skip the renderer's unload
 * handlers and leave a ghost participant in the room until the server timed it out.
 */
export const closeHuddle = () => {
  alive()?.close()
}
