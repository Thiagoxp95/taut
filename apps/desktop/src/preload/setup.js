import { contextBridge, ipcRenderer } from 'electron'
/**
 * A separate preload from `index.ts` on purpose: only the shell's own local
 * page can repoint the app at another server, never a page an instance serves.
 */
const setup = {
  state: () => ipcRenderer.invoke('taut:setup:state'),
  connect: (url) => ipcRenderer.invoke('taut:setup:connect', url)
}
try {
  contextBridge.exposeInMainWorld('tautSetup', setup)
} catch (error) {
  console.error(error)
}
