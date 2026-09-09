import { BrowserWindow, desktopCapturer, shell } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
/** Cookies (and therefore the login session) survive restarts in this partition. */
export const PARTITION = 'persist:taut'
/** Schemes the shell's own chrome needs; none of them can reach the network. */
const LOCAL_SCHEMES = new Set([
  'devtools:',
  'file:',
  'data:',
  'blob:',
  'about:',
  'chrome:',
  'chrome-extension:'
])
let allowedOrigins = new Set()
/** The one place the allowlist widens: the configured instance (+ the dev server). */
export const setAllowedOrigins = (origins) => {
  allowedOrigins = new Set(origins)
}
/**
 * Media servers the page has named (docs/build-plan-calls.md). A self-hosted LiveKit is a
 * second origin, and only the page knows its URL — it arrives with the join credentials — so
 * the renderer has to be the one to name it. What that buys is deliberately thin: these
 * origins carry the resource types below and nothing else, so naming one cannot turn into an
 * off-origin image, script or frame. Capped so a loop cannot accumulate origins.
 */
const MEDIA_RESOURCE_TYPES = new Set(['webSocket', 'xhr', 'media'])
const MAX_MEDIA_ORIGINS = 4
const mediaOrigins = new Set()
export const allowMediaOrigin = (raw) => {
  const origin = originOf(raw)
  if (origin === undefined || allowedOrigins.has(origin)) return
  if (mediaOrigins.size >= MAX_MEDIA_ORIGINS) mediaOrigins.delete([...mediaOrigins][0])
  mediaOrigins.add(origin)
}
/** Test seam: the shell never clears these itself, a restart does. */
export const clearMediaOrigins = () => mediaOrigins.clear()
/** `ws://host` and `http://host` are the same principal for the allowlist. */
const originOf = (raw) => {
  try {
    const url = new URL(raw)
    if (url.protocol === 'ws:') return `http://${url.host}`
    if (url.protocol === 'wss:') return `https://${url.host}`
    return url.origin
  } catch {
    return undefined
  }
}
export const isAllowed = (raw, resourceType) => {
  const scheme = raw.slice(0, raw.indexOf(':') + 1).toLowerCase()
  if (LOCAL_SCHEMES.has(scheme)) return true
  const origin = originOf(raw)
  if (origin === undefined) return false
  if (allowedOrigins.has(origin)) return true
  return (
    mediaOrigins.has(origin) && resourceType !== undefined && MEDIA_RESOURCE_TYPES.has(resourceType)
  )
}
/**
 * Default-deny for the whole partition: a Taut window may talk to its own
 * instance and to nothing else, so a compromised page cannot exfiltrate the
 * session cookie by loading an off-origin image or opening a socket. The one
 * exception is a media origin the page named through the bridge, and that one
 * is narrowed to signalling and media traffic (`allowMediaOrigin`).
 */
export const installRequestFilter = (session) => {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowed(details.url, details.resourceType) })
  })
}
/**
 * Screen share inside the shell (docs/build-plan-calls.md). Electron gives `getDisplayMedia`
 * no picker of its own: without a handler the promise rejects with nothing to show for it and
 * the share button in the huddle bar looks broken. This grants the first screen, which is the
 * whole-desktop case Slack huddles start from.
 *
 * // TODO(plan) a source picker (windows and tabs, not just screens) and `audio: 'loopback'`,
 * which needs a per-platform capture path rather than one flag.
 */
export const installDisplayMediaHandler = (session) => {
  session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const screen = sources[0]
          // An empty list means the OS has not granted screen recording; refusing is the
          // only honest answer, and the browser surfaces it as a cancelled share.
          callback(screen === undefined ? {} : { video: screen })
        })
        .catch(() => callback({}))
    },
    // Electron would otherwise draw its own "sharing" overlay over a window we do not own.
    { useSystemPicker: false }
  )
}
/**
 * Chrome every window the shell owns shares. Split out of `createWindow` because the huddle
 * window is built elsewhere (`main/huddle.ts`, docs/build-plan-huddle-window.md D13) and must
 * not drift from the main window's hardening — a second window on the same partition carries
 * the same login cookie, so it has to carry the same guards.
 */
export const shellWebPreferences = (preload) => ({
  preload: join(__dirname, `../preload/${preload}.js`),
  partition: PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: true
})
/** `hiddenInset` on macOS; the web layout pads itself when `window.taut` exists. */
export const shellChrome = () => ({
  autoHideMenuBar: process.platform !== 'darwin',
  ...(process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
    : {}),
  ...(process.platform === 'linux' ? { icon } : {})
})
export const installNavigationGuards = (window) => {
  // Links to anywhere else are the OS browser's problem, never a new Taut window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Belt and braces over the request filter: a top-level navigation off the
  // instance origin leaves the window where it is and opens externally.
  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowed(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
}
export const createWindow = (options) => {
  const window = new BrowserWindow({
    width: options.preload === 'setup' ? 520 : 1200,
    height: options.preload === 'setup' ? 480 : 800,
    minWidth: 420,
    minHeight: 400,
    show: false,
    ...shellChrome(),
    webPreferences: shellWebPreferences(options.preload)
  })
  window.on('ready-to-show', () => window.show())
  installNavigationGuards(window)
  return window
}
