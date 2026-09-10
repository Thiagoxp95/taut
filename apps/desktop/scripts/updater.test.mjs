import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createDesktopUpdater } from '../src/main/updater.ts'

// Electron's network/native installer is the boundary; state and orchestration are real.
class Installer extends EventEmitter {
  async checkForUpdates() {
    this.emit('update-available', { version: '1.0.1' })
    return {}
  }
  async downloadUpdate() {
    this.emit('download-progress', { percent: 42.8 })
    this.emit('update-downloaded', { version: '1.0.1' })
    return []
  }
  quitAndInstall() {
    this.installed = true
  }
}
const setup = (enabled = true, installer = new Installer()) => {
  const states = []
  const controller = createDesktopUpdater({
    updater: installer,
    enabled,
    version: '1.0.0',
    changed: (state) => states.push(state),
    prepareRestart: async () => {}
  })
  return { installer, controller, states }
}

test('downloads a release and installs only after explicit restart', async () => {
  const { controller, installer, states } = setup()
  await controller.check()
  assert.deepEqual(
    states.map((s) => s.status),
    ['checking', 'downloading', 'downloading', 'ready']
  )
  assert.equal(states[2].percent, 42)
  assert.equal(controller.state().version, '1.0.1')
  assert.equal(installer.installed, undefined)
  assert.equal(installer.autoInstallOnAppQuit, false)
  await controller.restart()
  assert.equal(installer.installed, true)
})

test('development and unsigned builds cannot download or restart', async () => {
  const { controller, installer } = setup(false)
  await controller.check()
  await controller.restart()
  assert.equal(controller.state().status, 'disabled')
  assert.equal(installer.installed, undefined)
})

test('restart before download completes is ignored', async () => {
  const { controller, installer } = setup()
  await controller.restart()
  assert.equal(installer.installed, undefined)
})

test('a network failure is recoverable and never leaks the raw error to the page', async () => {
  const { controller, installer } = setup()
  installer.checkForUpdates = async () => {
    throw Error('private diagnostic')
  }
  await controller.check()
  assert.equal(controller.state().status, 'error')
  assert.doesNotMatch(JSON.stringify(controller.state()), /private diagnostic/)
  installer.checkForUpdates = async () =>
    installer.emit('update-not-available', { version: '1.0.0' })
  await controller.check()
  assert.equal(controller.state().status, 'current')
})

test('concurrent checks and checks while ready cannot erase a downloaded update', async () => {
  const { controller, installer } = setup()
  let resolve
  installer.checkForUpdates = () =>
    new Promise((r) => {
      resolve = r
    })
  const pending = controller.check()
  const second = controller.check()
  installer.emit('update-not-available', { version: '1.0.0' })
  resolve({})
  await Promise.all([pending, second])
  installer.emit('update-downloaded', { version: '1.0.1' })
  await controller.check()
  assert.equal(controller.state().status, 'ready')
})

test('a download failure permits a fresh check and successful download', async () => {
  const { controller, installer } = setup()
  installer.downloadUpdate = async () => {
    throw Error('download failed')
  }
  await controller.check()
  assert.equal(controller.state().status, 'error')
  installer.downloadUpdate = Installer.prototype.downloadUpdate
  await controller.check()
  assert.equal(controller.state().status, 'ready')
})

test('prepares active local work before native restart and ignores double clicks', async () => {
  const installer = new Installer()
  let finish
  const controller = createDesktopUpdater({
    updater: installer,
    enabled: true,
    version: '1.0.0',
    changed: () => {},
    prepareRestart: () =>
      new Promise((r) => {
        finish = r
      })
  })
  await controller.check()
  const pending = controller.restart()
  await controller.restart()
  assert.equal(installer.installed, undefined)
  finish()
  await pending
  assert.equal(installer.installed, true)
})
