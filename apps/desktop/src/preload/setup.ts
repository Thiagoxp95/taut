import type { DesktopUpdateBridge } from '@taut/contract/desktop'
import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectResult, SetupState, TautSetupBridge } from './setup-types'

/**
 * A separate preload from `index.ts` on purpose: only the shell's own local
 * page can repoint the app at another server, never a page an instance serves.
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

const setup: TautSetupBridge = {
  updates,
  state: () => ipcRenderer.invoke('taut:setup:state') as Promise<SetupState>,
  connect: (url: string) => ipcRenderer.invoke('taut:setup:connect', url) as Promise<ConnectResult>
}

try {
  contextBridge.exposeInMainWorld('tautSetup', setup)
} catch (error) {
  console.error(error)
}
