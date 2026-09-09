import { Menu, app, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  readonly switchInstance: () => void
  /** ⌘, — the closest thing Taut has to preferences. */
  readonly openSettings: () => void
}

const isMac = process.platform === 'darwin'

/** Standard Edit/View/Window menus plus the two things this shell adds. */
export const installMenu = (actions: MenuActions): void => {
  const switchInstance: MenuItemConstructorOptions = {
    label: 'Switch instance…',
    accelerator: 'CommandOrControl+Shift+O',
    click: () => actions.switchInstance()
  }
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    click: () => actions.openSettings()
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settings,
              switchInstance,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : ([
          {
            label: 'File',
            submenu: [settings, switchInstance, { type: 'separator' }, { role: 'quit' }]
          }
        ] satisfies MenuItemConstructorOptions[])),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? ([{ role: 'pasteAndMatchStyle' }] satisfies MenuItemConstructorOptions[]) : []),
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CommandOrControl+R' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ] satisfies MenuItemConstructorOptions[])
          : ([{ role: 'close' }] satisfies MenuItemConstructorOptions[]))
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
