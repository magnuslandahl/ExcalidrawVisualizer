import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { DocumentController } from './document-controller'
import { installApplicationMenu } from './menu'
import { RecentFiles } from './recent-files'
import {
  ipcChannels,
  type AppCommand,
  type SaveRequest
} from '../shared/contracts'
import type { ExcalidrawScene } from '../shared/scene'

let mainWindow: BrowserWindow | undefined
let controller: DocumentController | undefined
let rendererDirty = false
let allowQuit = false
let pendingOpenPath: string | undefined
let rendererReady = false

const getExcalidrawPath = (argv: readonly string[]): string | undefined =>
  argv.find((argument) => argument.toLowerCase().endsWith('.excalidraw'))

const sendCommand = (command: AppCommand): void => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.appCommand, command)
  }
}

const attachWindowGuards = (window: BrowserWindow): void => {
  window.on('close', (event) => {
    if (!rendererDirty || allowQuit) {
      return
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'This drawing has unsaved changes or an unresolved conflict.',
      detail: 'Quit without saving those changes?',
      buttons: ['Cancel', 'Quit Without Saving'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 0) {
      event.preventDefault()
    } else {
      allowQuit = true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: '#f8f9fb',
    title: 'Excalidraw Visualizer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  attachWindowGuards(window)
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
      rendererReady = false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const isSaveRequest = (value: unknown): value is SaveRequest =>
  typeof value === 'object' && value !== null && 'scene' in value

const requireScene = (request: unknown): ExcalidrawScene => {
  if (!isSaveRequest(request)) {
    throw new TypeError('Invalid save request')
  }
  return request.scene
}

const registerIpc = (): void => {
  ipcMain.handle(ipcChannels.openDialog, () => controller?.showOpenDialog() ?? false)
  ipcMain.handle(ipcChannels.openPath, (_event, path: unknown) => {
    if (typeof path !== 'string') {
      throw new TypeError('Invalid file path')
    }
    return controller?.openPath(path) ?? false
  })
  ipcMain.handle(ipcChannels.save, (_event, request: unknown) =>
    controller?.save(requireScene(request))
  )
  ipcMain.handle(ipcChannels.saveAs, (_event, request: unknown) =>
    controller?.saveAs(requireScene(request))
  )
  ipcMain.handle(ipcChannels.reload, () => controller?.reload() ?? false)
  ipcMain.on(ipcChannels.setDirty, (_event, dirty: unknown) => {
    if (typeof dirty !== 'boolean') {
      throw new TypeError('Invalid dirty state')
    }
    rendererDirty = dirty
  })
  ipcMain.handle(ipcChannels.rendererReady, () => {
    rendererReady = true
    const path = pendingOpenPath
    pendingOpenPath = undefined
    return path
  })
}

const initialize = async (): Promise<void> => {
  app.setAppUserModelId('com.excalidrawvisualizer.app')
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  const recentFiles = new RecentFiles(join(app.getPath('userData'), 'recent-files.json'))
  await recentFiles.load()

  pendingOpenPath ??= getExcalidrawPath(process.argv.slice(1))
  controller = new DocumentController({
    getWindow: () => mainWindow,
    recentFiles,
    onRecentFilesChanged: () =>
      installApplicationMenu({ getWindow: () => mainWindow, recentFiles })
  })
  registerIpc()
  mainWindow = createWindow()
  installApplicationMenu({ getWindow: () => mainWindow, recentFiles })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
    const path = getExcalidrawPath(argv)
    if (path) {
      if (rendererReady) {
        sendCommand({ type: 'open-path', path })
      } else {
        pendingOpenPath = path
      }
    }
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (mainWindow && rendererReady) {
      sendCommand({ type: 'open-path', path })
    } else {
      pendingOpenPath = path
    }
  })

  app.whenReady().then(initialize).catch((error: unknown) => {
    dialog.showErrorBox(
      'Excalidraw Visualizer failed to start',
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      rendererReady = false
      mainWindow = createWindow()
    }
  })

  app.on('before-quit', () => {
    if (!rendererDirty) {
      allowQuit = true
    }
  })

  app.on('will-quit', () => {
    void controller?.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
