import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, normalize } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import { ActiveFileWatcher, type FileWatcherEvent } from './file-watcher'
import { fingerprint } from './fingerprint'
import type { RecentFiles } from './recent-files'
import {
  ipcChannels,
  type DocumentEvent,
  type OpenedDocument,
  type SaveResult
} from '../shared/contracts'
import {
  parseSceneText,
  serializeScene,
  type ExcalidrawScene
} from '../shared/scene'

type ControllerOptions = {
  getWindow: () => BrowserWindow | undefined
  recentFiles: RecentFiles
  onRecentFilesChanged: () => void
}

type WatchedDocument = {
  path: string
  watcher: ActiveFileWatcher
}

const pathKey = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

export const validateExcalidrawPath = (requestedPath: string): string => {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new TypeError('A file path is required')
  }
  if (!isAbsolute(requestedPath)) {
    throw new TypeError('Only absolute file paths are accepted')
  }
  if (extname(requestedPath).toLowerCase() !== '.excalidraw') {
    throw new TypeError('Only .excalidraw files are supported')
  }
  return normalize(requestedPath)
}

export class DocumentController {
  readonly #getWindow: () => BrowserWindow | undefined
  readonly #recentFiles: RecentFiles
  readonly #onRecentFilesChanged: () => void
  readonly #documents = new Map<string, WatchedDocument>()

  constructor(options: ControllerOptions) {
    this.#getWindow = options.getWindow
    this.#recentFiles = options.recentFiles
    this.#onRecentFilesChanged = options.onRecentFilesChanged
  }

  async showOpenDialog(): Promise<OpenedDocument[]> {
    const window = this.#getWindow()
    if (!window) {
      return []
    }
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Excalidraw files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Excalidraw drawings', extensions: ['excalidraw'] }]
    })
    const existingKeys = new Set(this.#documents.keys())
    const opened: OpenedDocument[] = []
    try {
      for (const path of result.filePaths) {
        opened.push(await this.openPath(path))
      }
      return opened
    } catch (error) {
      await Promise.all(
        opened
          .filter(({ path }) => !existingKeys.has(pathKey(path)))
          .map(({ path }) => this.closeDocument(path))
      )
      throw error
    }
  }

  async openPath(requestedPath: string): Promise<OpenedDocument> {
    const validatedPath = validateExcalidrawPath(requestedPath)
    const path =
      this.#documents.get(pathKey(validatedPath))?.path ?? validatedPath
    const document = await this.#readDocument(path)
    await this.#ensureWatcher(path, document.fingerprint)
    await this.#recordRecent(path)
    return document
  }

  async reload(requestedPath: string): Promise<OpenedDocument> {
    return this.openPath(requestedPath)
  }

  async save(path: string, scene: ExcalidrawScene): Promise<SaveResult> {
    return this.#writeScene(validateExcalidrawPath(path), scene)
  }

  async saveAs(
    currentPath: string,
    scene: ExcalidrawScene
  ): Promise<SaveResult> {
    const sourcePath = validateExcalidrawPath(currentPath)
    const window = this.#getWindow()
    if (!window) {
      return { ok: false, message: 'The application window is unavailable' }
    }
    const result = await dialog.showSaveDialog(window, {
      title: 'Save Excalidraw file',
      defaultPath: sourcePath,
      filters: [{ name: 'Excalidraw drawings', extensions: ['excalidraw'] }]
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true }
    }

    const requestedPath = result.filePath.toLowerCase().endsWith('.excalidraw')
      ? result.filePath
      : `${result.filePath}.excalidraw`
    const destinationPath = validateExcalidrawPath(requestedPath)
    const sourceKey = pathKey(sourcePath)
    const destinationKey = pathKey(destinationPath)
    if (sourceKey !== destinationKey && this.#documents.has(destinationKey)) {
      return {
        ok: false,
        message: 'That drawing is already open in this window'
      }
    }
    return this.#writeScene(destinationPath, scene, sourcePath)
  }

  async closeDocument(requestedPath: string): Promise<void> {
    const path = validateExcalidrawPath(requestedPath)
    const key = pathKey(path)
    const document = this.#documents.get(key)
    if (!document) {
      return
    }
    this.#documents.delete(key)
    await document.watcher.close()
  }

  async close(): Promise<void> {
    const documents = [...this.#documents.values()]
    this.#documents.clear()
    await Promise.all(documents.map(({ watcher }) => watcher.close()))
  }

  async #readDocument(path: string): Promise<OpenedDocument> {
    const content = await readFile(path, 'utf8')
    return {
      path,
      scene: parseSceneText(content),
      fingerprint: fingerprint(content)
    }
  }

  async #writeScene(
    path: string,
    sceneCandidate: ExcalidrawScene,
    previousPath?: string
  ): Promise<SaveResult> {
    let content: string
    try {
      content = serializeScene(parseSceneText(JSON.stringify(sceneCandidate)))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid save payload'
      this.#send({ type: 'save-failed', path, message })
      return { ok: false, message }
    }

    const contentFingerprint = fingerprint(content)
    const key = pathKey(path)

    try {
      await atomicWriteFile(path, content)
      const existing = this.#documents.get(key)
      existing?.watcher.markOwnWrite(contentFingerprint)
      await this.#ensureWatcher(path, contentFingerprint)
      if (previousPath && pathKey(previousPath) !== key) {
        await this.closeDocument(previousPath)
      }
      await this.#recordRecent(path)
      this.#send({ type: 'save-complete', path, fingerprint: contentFingerprint })
      return { ok: true, path, fingerprint: contentFingerprint }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save the file'
      this.#send({ type: 'save-failed', path, message })
      return { ok: false, message }
    }
  }

  async #ensureWatcher(path: string, initialFingerprint: string): Promise<void> {
    const key = pathKey(path)
    if (this.#documents.has(key)) {
      return
    }
    const watcher = new ActiveFileWatcher(path, {
      onEvent: (event) => this.#handleWatcherEvent(path, event)
    })
    await watcher.start(initialFingerprint)
    if (this.#documents.has(key)) {
      await watcher.close()
      return
    }
    this.#documents.set(key, { path, watcher })
  }

  #handleWatcherEvent(path: string, event: FileWatcherEvent): void {
    if (event.type === 'scene') {
      this.#send({
        type: 'external-change',
        document: { path, scene: event.scene, fingerprint: event.fingerprint }
      })
    } else if (event.type === 'invalid') {
      this.#send({ type: 'invalid-external', path, message: event.message })
    } else {
      this.#send({ type: 'file-missing', path })
    }
  }

  async #recordRecent(path: string): Promise<void> {
    await this.#recentFiles.add(path)
    this.#onRecentFilesChanged()
  }

  #send(event: DocumentEvent): void {
    const window = this.#getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(ipcChannels.documentEvent, event)
    }
  }
}
