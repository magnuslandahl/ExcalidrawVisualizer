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

  const fileSubmenu: MenuItemConstructorOptions[] = [
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
    }
  ]

  if (process.platform !== 'darwin') {
    fileSubmenu.push({ type: 'separator' }, { role: 'quit' })
  }

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: fileSubmenu
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
    }
  ]

  if (process.platform === 'darwin') {
    template.push({ role: 'windowMenu' })
  }

  if (!app.isPackaged) {
    template.push({
      label: 'Developer',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
