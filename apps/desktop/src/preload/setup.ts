import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectResult, SetupState, TautSetupBridge } from './setup-types'

/**
 * A separate preload from `index.ts` on purpose: only the shell's own local
 * page can repoint the app at another server, never a page an instance serves.
 */
const setup: TautSetupBridge = {
  state: () => ipcRenderer.invoke('taut:setup:state') as Promise<SetupState>,
  connect: (url: string) => ipcRenderer.invoke('taut:setup:connect', url) as Promise<ConnectResult>
}

try {
  contextBridge.exposeInMainWorld('tautSetup', setup)
} catch (error) {
  console.error(error)
}
