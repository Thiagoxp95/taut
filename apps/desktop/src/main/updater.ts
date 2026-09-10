import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateState } from '@taut/contract/desktop'

type Installer = Pick<
  AppUpdater,
  | 'on'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowPrerelease'
  | 'allowDowngrade'
>

/** Owns update state; the server and renderer never choose a feed or installer path. */
export function createDesktopUpdater(options: {
  updater: Installer
  enabled: boolean
  version: string
  changed: (state: DesktopUpdateState) => void
  prepareRestart: () => Promise<void>
}) {
  const { updater, enabled, version, changed } = options
  let state: DesktopUpdateState = { status: enabled ? 'idle' : 'disabled', version }
  let checking: Promise<void> | undefined
  let download: Promise<unknown> | undefined
  const publish = (next: DesktopUpdateState): void => {
    state = next
    changed(next)
  }
  const failed = (): void =>
    publish({
      status: 'error',
      version,
      message: 'Could not update Taut. Check your connection and try again.'
    })

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  if (enabled) {
    updater.on('error', failed)
    updater.on('update-not-available', () => publish({ status: 'current', version }))
    updater.on('update-available', (info) => {
      publish({ status: 'downloading', version: info.version, percent: 0 })
      download = updater.downloadUpdate().catch(failed)
    })
    updater.on('download-progress', (progress) => {
      if (state.status === 'downloading')
        publish({ ...state, percent: Math.max(0, Math.min(100, Math.floor(progress.percent))) })
    })
    updater.on('update-downloaded', (info) => publish({ status: 'ready', version: info.version }))
  }

  return {
    state: (): DesktopUpdateState => state,
    check: (): Promise<void> => {
      if (checking) return checking
      if (!enabled || ['ready', 'restarting', 'downloading'].includes(state.status))
        return Promise.resolve()
      publish({ status: 'checking', version })
      checking = (async () => {
        try {
          await updater.checkForUpdates()
          await download
        } catch {
          failed()
        }
      })().finally(() => {
        checking = undefined
        download = undefined
      })
      return checking
    },
    restart: async (): Promise<void> => {
      if (!enabled || state.status !== 'ready') return
      publish({ status: 'restarting', version: state.version })
      try {
        await options.prepareRestart()
        updater.quitAndInstall()
      } catch {
        failed()
      }
    }
  }
}
