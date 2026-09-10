import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopNavigateHandler,
  DesktopNotification,
  TautBridge
} from '@taut/contract/desktop'

/**
 * The huddle window's preload (docs/build-plan-huddle-window.md D13). The huddle route is an
 * ordinary page of the web app, so it must see the same `window.taut` as the main window: it
 * calls `allowMediaOrigin` before connecting to LiveKit, `closeHuddle` when the user leaves and
 * `focusMain` for "back to Taut". A separate entry only because a window's preload path is fixed
 * at construction.
 *
 * A copy of `index.ts` rather than an import of a shared module, and that is not an oversight:
 * these preloads run sandboxed, where `require` resolves Electron built-ins and nothing else, so
 * a module both entries import becomes `require('./chunks/…')` in the bundle and throws before
 * `window.taut` exists. The two stay honest because both are typed `TautBridge` (D12) — a member
 * added to the contract fails to compile here as well.
 */

const NAVIGATE_CHANNEL = 'taut:navigate'

interface ShellInfo {
  readonly version: string
  readonly platform: string
}

const info = ((): ShellInfo => {
  const raw: unknown = ipcRenderer.sendSync('taut:info')
  return typeof raw === 'object' && raw !== null
    ? (raw as ShellInfo)
    : { version: '0.0.0', platform: process.platform }
})()

const taut: TautBridge = {
  platform: info.platform,
  version: info.version,
  connectClaude: () => ipcRenderer.invoke('taut:claude:connect'),
  cancelClaudeConnect: () => ipcRenderer.send('taut:claude:cancel'),
  setBadge: (count: number) => ipcRenderer.send('taut:badge', count),
  notify: (notification: DesktopNotification) => ipcRenderer.send('taut:notify', notification),
  allowMediaOrigin: (url: string) => ipcRenderer.send('taut:media-origin', url),
  openHuddle: (path: string) => ipcRenderer.send('taut:huddle:open', path),
  closeHuddle: () => ipcRenderer.send('taut:huddle:close'),
  focusMain: () => ipcRenderer.send('taut:focus-main'),
  onNavigate: (handler: DesktopNavigateHandler) => {
    const listener = (_event: unknown, path: unknown): void => {
      if (typeof path === 'string') handler(path)
    }
    ipcRenderer.on(NAVIGATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(NAVIGATE_CHANNEL, listener)
    }
  }
}

/** `apps/web` styles the macOS titlebar strip off this class. */
const markDesktop = (): void => {
  document.documentElement.classList.add('desktop')
  document.documentElement.dataset.tautPlatform = info.platform
}

try {
  contextBridge.exposeInMainWorld('taut', taut)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markDesktop, { once: true })
  } else {
    markDesktop()
  }
} catch (error) {
  console.error(error)
}
