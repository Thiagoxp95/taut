import type { DesktopUpdateBridge } from '@taut/contract/desktop'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopNavigateHandler,
  DesktopNotification,
  TautBridge
} from '@taut/contract/desktop'

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

/**
 * The whole surface `apps/web` may use — deliberately few members, all
 * structured-cloneable, so nothing Electron-shaped leaks into the page.
 * The type lives in `@taut/contract/desktop` because both sides import it.
 *
 * `huddle.ts` is a deliberate copy of this file (see the note there).
 */
const updates: DesktopUpdateBridge = {
  state: () => ipcRenderer.invoke('taut:update:state'),
  check: () => ipcRenderer.invoke('taut:update:check'),
  restart: () => ipcRenderer.invoke('taut:update:restart'),
  onState: (handler) => {
    const listener = (_event: unknown, state: Parameters<typeof handler>[0]): void => handler(state)
    ipcRenderer.on('taut:update:state', listener)
    return () => {
      ipcRenderer.removeListener('taut:update:state', listener)
    }
  }
}

const taut: TautBridge = {
  updates,
  platform: info.platform,
  version: info.version,
  connectClaude: () => ipcRenderer.invoke('taut:claude:connect'),
  cancelClaudeConnect: () => ipcRenderer.send('taut:claude:cancel'),
  setBadge: (count: number) => ipcRenderer.send('taut:badge', count),
  notify: (notification: DesktopNotification) => ipcRenderer.send('taut:notify', notification),
  allowMediaOrigin: (url: string) => ipcRenderer.send('taut:media-origin', url),
  // The page asks for a huddle window and stops there (docs/build-plan-huddle-window.md D12):
  // geometry and lifetime are the shell's business, and the main window must not connect to the
  // room itself (D6) or the same person is in it twice.
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
