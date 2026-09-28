import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import {
  DocumentController,
  validateExcalidrawPath
} from './document-controller'
import { installApplicationMenu } from './menu'
import { RecentFiles } from './recent-files'
import {
  ipcChannels,
  type AppCommand,
  type SaveRequest
} from '../shared/contracts'
import type { ExcalidrawScene } from '../shared/scene'

type WindowContext = {
  window: BrowserWindow
  controller: DocumentController
  pendingOpenPaths: string[]
  rendererReady: boolean
  dirty: boolean
  allowClose: boolean
}

const windows = new Map<number, WindowContext>()
const pendingLaunchPaths: string[] = []
let recentFiles: RecentFiles | undefined

const getExcalidrawPaths = (argv: readonly string[]): string[] =>
  argv.filter((argument) => argument.toLowerCase().endsWith('.excalidraw'))

const getPreferredWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ??
  [...windows.values()].at(-1)?.window

const sendCommand = (window: BrowserWindow, command: AppCommand): void => {
  if (!window.isDestroyed()) {
    window.webContents.send(ipcChannels.appCommand, command)
  }
}

const refreshApplicationMenu = (): void => {
  if (!recentFiles) {
    return
  }
  installApplicationMenu({ getWindow: getPreferredWindow, recentFiles })
}

const attachWindowGuards = (context: WindowContext): void => {
  const { window } = context
  window.on('close', (event) => {
    if (!context.dirty || context.allowClose) {
      return
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'One or more drawings have unsaved changes or unresolved conflicts.',
      detail: 'Close this window without saving those changes?',
      buttons: ['Cancel', 'Close Without Saving'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 0) {
      event.preventDefault()
    } else {
      context.allowClose = true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}

function createWindow(initialPaths: readonly string[] = []): BrowserWindow {
  if (!recentFiles) {
    throw new Error('Recent files are not initialized')
  }

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
  const context: WindowContext = {
    window,
    controller: new DocumentController({
      getWindow: () => window,
      recentFiles,
      onRecentFilesChanged: refreshApplicationMenu
    }),
    pendingOpenPaths: [...initialPaths],
    rendererReady: false,
    dirty: false,
    allowClose: false
  }
  windows.set(window.id, context)
  attachWindowGuards(context)

  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    windows.delete(window.id)
    void context.controller.close()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const requireWindowContext = (
  sender: Electron.WebContents
): WindowContext => {
  const window = BrowserWindow.fromWebContents(sender)
  const context = window ? windows.get(window.id) : undefined
  if (!context) {
    throw new Error('The application window is unavailable')
  }
  return context
}

const isSaveRequest = (value: unknown): value is SaveRequest =>
  typeof value === 'object' &&
  value !== null &&
  'path' in value &&
  typeof value.path === 'string' &&
  'scene' in value

const requireSaveRequest = (
  request: unknown
): { path: string; scene: ExcalidrawScene } => {
  if (!isSaveRequest(request)) {
    throw new TypeError('Invalid save request')
  }
  return request
}

const requirePath = (path: unknown): string => {
  if (typeof path !== 'string') {
    throw new TypeError('Invalid file path')
  }
  return validateExcalidrawPath(path)
}

const registerIpc = (): void => {
  ipcMain.handle(ipcChannels.openDialog, (event) =>
    requireWindowContext(event.sender).controller.showOpenDialog()
  )
  ipcMain.handle(ipcChannels.openPath, (event, path: unknown) =>
    requireWindowContext(event.sender).controller.openPath(requirePath(path))
  )
  ipcMain.handle(ipcChannels.save, (event, request: unknown) => {
    const { path, scene } = requireSaveRequest(request)
    return requireWindowContext(event.sender).controller.save(path, scene)
  })
  ipcMain.handle(ipcChannels.saveAs, (event, request: unknown) => {
    const { path, scene } = requireSaveRequest(request)
    return requireWindowContext(event.sender).controller.saveAs(path, scene)
  })
  ipcMain.handle(ipcChannels.reload, (event, path: unknown) =>
    requireWindowContext(event.sender).controller.reload(requirePath(path))
  )
  ipcMain.handle(ipcChannels.closeDocument, (event, path: unknown) =>
    requireWindowContext(event.sender).controller.closeDocument(requirePath(path))
  )
  ipcMain.handle(ipcChannels.openInNewWindow, (event, path: unknown) => {
    requireWindowContext(event.sender)
    createWindow([requirePath(path)])
  })
  ipcMain.on(ipcChannels.setDirty, (event, dirty: unknown) => {
    if (typeof dirty !== 'boolean') {
      throw new TypeError('Invalid dirty state')
    }
    requireWindowContext(event.sender).dirty = dirty
  })
  ipcMain.handle(ipcChannels.rendererReady, (event) => {
    const context = requireWindowContext(event.sender)
    context.rendererReady = true
    return context.pendingOpenPaths.splice(0)
  })
}

const deliverPath = (path: string): void => {
  const window = getPreferredWindow()
  if (!window) {
    pendingLaunchPaths.push(path)
    return
  }
  const context = windows.get(window.id)
  if (context?.rendererReady) {
    sendCommand(window, { type: 'open-path', path })
  } else {
    context?.pendingOpenPaths.push(path)
  }
  if (window.isMinimized()) {
    window.restore()
  }
  window.focus()
}

const initialize = async (): Promise<void> => {
  app.setAppUserModelId('com.excalidrawvisualizer.app')
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  recentFiles = new RecentFiles(join(app.getPath('userData'), 'recent-files.json'))
  await recentFiles.load()

  pendingLaunchPaths.push(...getExcalidrawPaths(process.argv.slice(1)))
  registerIpc()
  createWindow(pendingLaunchPaths.splice(0))
  refreshApplicationMenu()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const paths = getExcalidrawPaths(argv)
    if (paths.length > 0) {
      for (const path of paths) {
        deliverPath(path)
      }
    } else {
      const window = getPreferredWindow()
      window?.show()
      window?.focus()
    }
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    deliverPath(path)
  })

  app.whenReady().then(initialize).catch((error: unknown) => {
    dialog.showErrorBox(
      'Excalidraw Visualizer failed to start',
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && recentFiles) {
      createWindow()
    }
  })

  app.on('will-quit', () => {
    for (const context of windows.values()) {
      void context.controller.close()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
