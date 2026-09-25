import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, normalize } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import { ActiveFileWatcher, type FileWatcherEvent } from './file-watcher'
import { fingerprint } from './fingerprint'
import type { RecentFiles } from './recent-files'
import { ipcChannels, type DocumentEvent, type SaveResult } from '../shared/contracts'
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

export class DocumentController {
  readonly #getWindow: () => BrowserWindow | undefined
  readonly #recentFiles: RecentFiles
  readonly #onRecentFilesChanged: () => void
  #activePath: string | undefined
  #watcher: ActiveFileWatcher | undefined

  constructor(options: ControllerOptions) {
    this.#getWindow = options.getWindow
    this.#recentFiles = options.recentFiles
    this.#onRecentFilesChanged = options.onRecentFilesChanged
  }

  async showOpenDialog(): Promise<boolean> {
    const window = this.#getWindow()
    if (!window) {
      return false
    }
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Excalidraw file',
      properties: ['openFile'],
      filters: [{ name: 'Excalidraw drawings', extensions: ['excalidraw'] }]
    })
    const selectedPath = result.filePaths[0]
    return selectedPath ? this.openPath(selectedPath) : false
  }

  async openPath(requestedPath: string): Promise<boolean> {
    const path = this.#validatePath(requestedPath)
    const content = await readFile(path, 'utf8')
    const scene = parseSceneText(content)
    const contentFingerprint = fingerprint(content)

    await this.#replaceWatcher(path, contentFingerprint)
    this.#activePath = path
    await this.#recordRecent(path)
    this.#send({
      type: 'opened',
      document: { path, scene, fingerprint: contentFingerprint }
    })
    return true
  }

  async reload(): Promise<boolean> {
    return this.#activePath ? this.openPath(this.#activePath) : false
  }

  async save(scene: ExcalidrawScene): Promise<SaveResult> {
    return this.#activePath ? this.#writeScene(this.#activePath, scene, false) : this.saveAs(scene)
  }

  async saveAs(scene: ExcalidrawScene): Promise<SaveResult> {
    const window = this.#getWindow()
    if (!window) {
      return { ok: false, message: 'The application window is unavailable' }
    }
    const result = await dialog.showSaveDialog(window, {
      title: 'Save Excalidraw file',
      defaultPath: this.#activePath ?? 'Untitled.excalidraw',
      filters: [{ name: 'Excalidraw drawings', extensions: ['excalidraw'] }]
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true }
    }

    const requestedPath = result.filePath.toLowerCase().endsWith('.excalidraw')
      ? result.filePath
      : `${result.filePath}.excalidraw`
    const path = this.#validatePath(requestedPath)
    return this.#writeScene(path, scene, path !== this.#activePath)
  }

  async close(): Promise<void> {
    await this.#watcher?.close()
    this.#watcher = undefined
  }

  async #writeScene(
    path: string,
    sceneCandidate: ExcalidrawScene,
    switchActiveFile: boolean
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
    const activeWatcher = !switchActiveFile ? this.#watcher : undefined

    try {
      await atomicWriteFile(path, content)
      activeWatcher?.markOwnWrite(contentFingerprint)
      if (switchActiveFile || !this.#watcher) {
        await this.#replaceWatcher(path, contentFingerprint)
      }
      this.#activePath = path
      await this.#recordRecent(path)
      this.#send({ type: 'save-complete', path, fingerprint: contentFingerprint })
      return { ok: true, path, fingerprint: contentFingerprint }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save the file'
      this.#send({ type: 'save-failed', path, message })
      return { ok: false, message }
    }
  }

  async #replaceWatcher(path: string, initialFingerprint: string): Promise<void> {
    await this.#watcher?.close()
    const watcher = new ActiveFileWatcher(path, {
      onEvent: (event) => this.#handleWatcherEvent(path, event)
    })
    await watcher.start(initialFingerprint)
    this.#watcher = watcher
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

  #validatePath(requestedPath: string): string {
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

  #send(event: DocumentEvent): void {
    const window = this.#getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(ipcChannels.documentEvent, event)
    }
  }
}
