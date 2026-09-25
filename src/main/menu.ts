import { app, Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { basename } from 'node:path'
import type { RecentFiles } from './recent-files'
import { ipcChannels, type AppCommand } from '../shared/contracts'

type MenuOptions = {
  getWindow: () => BrowserWindow | undefined
  recentFiles: RecentFiles
}

const sendCommand = (
  getWindow: () => BrowserWindow | undefined,
  command: AppCommand
): void => {
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    window.webContents.send(ipcChannels.appCommand, command)
  }
}

export const installApplicationMenu = (options: MenuOptions): void => {
  const recentItems: MenuItemConstructorOptions[] =
    options.recentFiles.paths.length === 0
      ? [{ label: 'No recent files', enabled: false }]
      : options.recentFiles.paths.map((path) => ({
          label: basename(path),
          sublabel: path,
          click: () => sendCommand(options.getWindow, { type: 'open-path', path })
        }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendCommand(options.getWindow, { type: 'open' })
        },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendCommand(options.getWindow, { type: 'save' })
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendCommand(options.getWindow, { type: 'save-as' })
        },
        {
          label: 'Reload from Disk',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => sendCommand(options.getWindow, { type: 'reload' })
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Alt+F4', click: () => app.quit() }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Fit to Content',
          accelerator: 'CmdOrCtrl+Shift+1',
          click: () => sendCommand(options.getWindow, { type: 'fit-to-content' })
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]

  if (!app.isPackaged) {
    template.push({
      label: 'Developer',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
