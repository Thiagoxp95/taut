import { app, ipcMain, session } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { Effect, Either, Layer, LogLevel, Logger, ManagedRuntime } from 'effect'
import { join } from 'node:path'
import { closeHuddle, openHuddle } from './huddle'
import { normalizeInstanceUrl, probeInstance } from './instance'
import { installMenu } from './menu'
import { runNotifier, setBadgeCount, show } from './notifier'
import { Realtime } from './realtime'
import { Store } from './store'
import {
  PARTITION,
  allowMediaOrigin,
  createWindow,
  installDisplayMediaHandler,
  installRequestFilter,
  setAllowedOrigins
} from './window'
const APP_ID = 'dev.taut.desktop'
const PROTOCOL = 'taut'
const SETTINGS_PATH = '/settings/company'
/**
 * In dev the shell points at the Vite dev server so the web app hot-reloads
 * inside Electron (`pnpm dev` in one terminal, `pnpm dev:desktop` in another);
 * a packaged build talks to the server that serves the built client.
 * `scripts/dev.sh` overrides it with the tailnet URL so the shell, the browser
 * and the phone all sit on one origin.
 */
const DEFAULT_INSTANCE_URL =
  process.env['TAUT_DEV_INSTANCE_URL'] ??
  (is.dev ? 'http://localhost:5173' : 'http://localhost:3000')
/** electron-vite serves the Connect screen from here while developing. */
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    Store.Default,
    Realtime.Default,
    // The shell's own socket is invisible from the renderer; in dev its log is
    // the only way to see why notifications are (or are not) arriving.
    Logger.minimumLogLevel(is.dev ? LogLevel.Debug : LogLevel.Info)
  )
)
let mainWindow = null
let mode = 'setup'
/** Queued while the instance page is still loading (deep link on a cold start). */
let pendingPath
/**
 * The instance the shell is currently attached to. Remembered because the huddle window is
 * opened from a path the page hands over (`/huddle/<channelId>?…`) and only the main process
 * knows which origin to hang it on (docs/build-plan-huddle-window.md D6).
 */
let currentInstanceUrl
const devOrigins = rendererDevUrl === undefined ? [] : [new URL(rendererDevUrl).origin]
const replaceWindow = (next) => {
  // The two modes need different preloads, and `webPreferences` is fixed at
  // construction — so switching modes means a new window.
  if (mainWindow !== null && !mainWindow.isDestroyed() && mode === next) return mainWindow
  const previous = mainWindow
  mode = next
  mainWindow = createWindow({ preload: next === 'setup' ? 'setup' : 'index' })
  if (previous !== null && !previous.isDestroyed()) previous.destroy()
  return mainWindow
}
const openSetup = () => {
  setAllowedOrigins(devOrigins)
  runtime.runFork(Effect.flatMap(Realtime, (realtime) => realtime.stop))
  setBadgeCount(0)
  currentInstanceUrl = undefined
  const window = replaceWindow('setup')
  // A huddle belongs to the instance we are leaving; closing it is the hard leave (D13).
  // After `replaceWindow`, so the shell is never momentarily windowless.
  closeHuddle()
  void (rendererDevUrl === undefined
    ? window.loadFile(join(__dirname, '../renderer/index.html'))
    : window.loadURL(rendererDevUrl))
}
const openInstance = (instanceUrl) => {
  // A huddle belongs to the instance it was started on, so a *different* instance ends it (D13).
  // Reopening the same one — the macOS dock with the main window closed — must leave it alone.
  const switched = currentInstanceUrl !== undefined && currentInstanceUrl !== instanceUrl
  setAllowedOrigins([instanceUrl, ...devOrigins])
  currentInstanceUrl = instanceUrl
  const window = replaceWindow('instance')
  if (switched) closeHuddle()
  void window.loadURL(instanceUrl)
  window.webContents.once('did-finish-load', () => {
    if (pendingPath === undefined) return
    window.webContents.send('taut:navigate', pendingPath)
    pendingPath = undefined
  })
  runtime.runFork(Effect.flatMap(Realtime, (realtime) => realtime.connect(instanceUrl, PARTITION)))
}
/**
 * Bring the main window forward and leave the page where it is — "back to Taut" from inside the
 * huddle window (docs/build-plan-huddle-window.md D12), which must not navigate the main window
 * out from under whatever the user was reading.
 */
const focusMain = () => {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}
/** Bring the app forward and route the web client (notification click, deep link, ⌘,). */
const open = (path) => {
  focusMain()
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mode !== 'instance') return
  if (mainWindow.webContents.isLoading()) {
    pendingPath = path
    return
  }
  mainWindow.webContents.send('taut:navigate', path)
}
/** `taut://c/chn_1?thread=msg_2` → `/c/chn_1?thread=msg_2`. */
const handleDeepLink = (raw) => {
  if (!raw.startsWith(`${PROTOCOL}://`)) return
  const rest = raw.slice(`${PROTOCOL}://`.length)
  open(`/${rest.replace(/^\/+/, '')}`)
}
const connect = (raw) =>
  Effect.gen(function* () {
    const normalized = normalizeInstanceUrl(typeof raw === 'string' ? raw : '')
    if (Either.isLeft(normalized)) {
      return { ok: false, message: normalized.left.message }
    }
    const url = normalized.right
    const health = yield* Effect.either(probeInstance(url))
    if (Either.isLeft(health)) {
      return { ok: false, message: health.left.message }
    }
    const store = yield* Store
    yield* store.setInstanceUrl(url)
    return { ok: true, url, version: health.right.version }
  })
const registerIpc = () => {
  // One synchronous call, at preload time, so `window.taut` is complete before
  // the web app's first line runs.
  ipcMain.on('taut:info', (event) => {
    event.returnValue = { version: app.getVersion(), platform: process.platform }
  })
  ipcMain.handle('taut:setup:state', () =>
    runtime.runPromise(
      Effect.flatMap(Store, (store) =>
        Effect.map(store.instanceUrl, (instanceUrl) => ({
          defaultUrl: DEFAULT_INSTANCE_URL,
          instanceUrl: instanceUrl._tag === 'Some' ? instanceUrl.value : undefined
        }))
      )
    )
  )
  ipcMain.handle('taut:setup:connect', async (_event, raw) => {
    const result = await runtime.runPromise(connect(raw))
    if (result.ok) openInstance(result.url)
    return result
  })
  // The page names its media server when it joins a huddle; the shell is default-deny per
  // origin and a self-hosted LiveKit is a second one (docs/build-plan-calls.md).
  ipcMain.on('taut:media-origin', (_event, url) => {
    if (typeof url === 'string') allowMediaOrigin(url)
  })
  // The huddle window, not the page that asked for it, owns the room (D6): the main window
  // hands over a path and stops there, so only one renderer ever holds the microphone.
  ipcMain.on('taut:huddle:open', (_event, path) => {
    if (typeof path !== 'string' || currentInstanceUrl === undefined) return
    openHuddle(currentInstanceUrl, path)
  })
  // Leaving is done in the window that is actually in the call; closing it is the leave (D13).
  ipcMain.on('taut:huddle:close', () => closeHuddle())
  ipcMain.on('taut:focus-main', () => focusMain())
  ipcMain.on('taut:badge', (_event, count) => {
    if (typeof count === 'number') setBadgeCount(count)
  })
  ipcMain.on('taut:notify', (_event, payload) => {
    if (typeof payload !== 'object' || payload === null) return
    const { title, body, channelId } = payload
    if (typeof title !== 'string') return
    show({
      title,
      body: typeof body === 'string' ? body : '',
      path: typeof channelId === 'string' ? `/c/${channelId}` : '/',
      hooks: { open }
    })
  })
}
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
    if (link === undefined) open('/')
    else handleDeepLink(link)
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })
  void app.whenReady().then(async () => {
    electronApp.setAppUserModelId(APP_ID)
    app.setAsDefaultProtocolClient(PROTOCOL)
    const partition = session.fromPartition(PARTITION)
    installRequestFilter(partition)
    installDisplayMediaHandler(partition)
    installMenu({ switchInstance: openSetup, openSettings: () => open(SETTINGS_PATH) })
    registerIpc()
    app.on('browser-window-created', (_event, window) => optimizer.watchWindowShortcuts(window))
    runtime.runFork(Effect.flatMap(Realtime, (realtime) => runNotifier(realtime.events, { open })))
    const stored = await runtime.runPromise(Effect.flatMap(Store, (store) => store.instanceUrl))
    if (stored._tag === 'Some') openInstance(stored.value)
    else openSetup()
    // macOS: the dock icon reopens whichever screen the shell is configured for. A huddle window
    // does not count as the app being up (D13) — with the main window closed and a call running,
    // the dock has to bring Taut itself back.
    app.on('activate', () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) return
      void runtime
        .runPromise(Effect.flatMap(Store, (store) => store.instanceUrl))
        .then((url) => (url._tag === 'Some' ? openInstance(url.value) : openSetup()))
    })
  })
  // Only fires when the huddle window *and* the main window are gone, so a huddle closing on
  // its own never quits the app (D13); on Windows and Linux closing the last of them still does.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    // Close rather than let the quit tear it down, so the renderer's unload handler still runs
    // and LiveKit gets its disconnect (D13).
    closeHuddle()
    void runtime.dispose()
  })
}
