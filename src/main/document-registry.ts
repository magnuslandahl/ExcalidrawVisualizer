import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path'
import { DocumentController } from './document-controller'
import type { RecentFiles } from './recent-files'
import type {
  DocumentEvent,
  OpenedDocument,
  SaveRequest,
  SaveResult
} from '../shared/contracts'
import { createEmptyScene } from '../shared/scene'

type RegistryOptions = {
  getWindow: () => BrowserWindow | undefined
  recentFiles: RecentFiles
  onEvent: (event: DocumentEvent) => void
  onRecentFilesChanged: () => void
}

const pathKey = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

const validateDocumentPath = (requestedPath: string): string => {
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

export const canonicalizeDocumentPath = async (
  requestedPath: string,
  destination = false
): Promise<string> => {
  const path = validateDocumentPath(requestedPath)
  try {
    return normalize(await realpath(path))
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (!destination || code !== 'ENOENT') {
      throw error
    }
    const canonicalParent = await realpath(dirname(path))
    return normalize(join(canonicalParent, basename(path)))
  }
}

export class DocumentRegistry {
  readonly #getWindow: () => BrowserWindow | undefined
  readonly #recentFiles: RecentFiles
  readonly #onEvent: (event: DocumentEvent) => void
  readonly #onRecentFilesChanged: () => void
  readonly #documents = new Map<string, DocumentController>()
  readonly #paths = new Map<string, string>()
  readonly #reservedPaths = new Set<string>()
  readonly #visibleDocuments = new Set<string>()

  constructor(options: RegistryOptions) {
    this.#getWindow = options.getWindow
    this.#recentFiles = options.recentFiles
    this.#onEvent = options.onEvent
    this.#onRecentFilesChanged = options.onRecentFilesChanged
  }

  async createDocument(): Promise<OpenedDocument> {
    const controller = this.#createController({ scene: createEmptyScene() })
    const document = controller.document
    this.#visibleDocuments.add(controller.id)
    this.#onEvent({ type: 'opened', document })
    return document
  }

  async showOpenDialog(): Promise<boolean> {
    const window = this.#getWindow()
    if (!window) {
      return false
    }
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Excalidraw files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Excalidraw drawings', extensions: ['excalidraw'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return false
    }
    for (const path of result.filePaths) {
      await this.openPath(path)
    }
    return true
  }

  async openPath(requestedPath: string): Promise<boolean> {
    const path = await canonicalizeDocumentPath(requestedPath)
    const existingId = this.#paths.get(pathKey(path))
    if (existingId) {
      const existing = this.#documents.get(existingId)
      if (!existing) {
        throw new Error('The document registry is inconsistent')
      }
      if (!this.#visibleDocuments.has(existingId)) {
        const document = await existing.open()
        this.#visibleDocuments.add(existingId)
        this.#onEvent({ type: 'opened', document })
      }
      this.#onEvent({ type: 'activate', documentId: existingId })
      return true
    }

    const controller = this.#createController({ path })
    const document = await controller.open()
    this.#paths.set(pathKey(path), controller.id)
    this.#visibleDocuments.add(controller.id)
    await this.#recordRecent(path)
    this.#onEvent({ type: 'opened', document })
    return true
  }

  async reload(documentId: string): Promise<boolean> {
    return this.#require(documentId).reload()
  }

  async save(request: SaveRequest): Promise<SaveResult> {
    const controller = this.#require(request.documentId)
    if (!controller.path) {
      return this.saveAs(request)
    }
    const result = await controller.save(request.scene)
    if (result.ok && result.document.path) {
      await this.#recordRecent(result.document.path)
    }
    return result
  }

  async saveAs(request: SaveRequest): Promise<SaveResult> {
    const source = this.#require(request.documentId)
    const window = this.#getWindow()
    if (!window) {
      return { ok: false, message: 'The application window is unavailable' }
    }

    const result = await dialog.showSaveDialog(window, {
      title: 'Save Excalidraw file',
      defaultPath: source.path ?? 'Untitled.excalidraw',
      filters: [{ name: 'Excalidraw drawings', extensions: ['excalidraw'] }]
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true }
    }

    const requestedPath = result.filePath.toLowerCase().endsWith('.excalidraw')
      ? result.filePath
      : `${result.filePath}.excalidraw`
    const path = await canonicalizeDocumentPath(requestedPath, true)
    const key = pathKey(path)
    const owner = this.#paths.get(key)
    if (owner && owner !== source.id) {
      return {
        ok: false,
        message: 'That path is already open or retained by another document'
      }
    }
    if (this.#reservedPaths.has(key)) {
      return { ok: false, message: 'Another save is already using that destination' }
    }

    this.#reservedPaths.add(key)
    try {
      if (!source.path || pathKey(source.path) === key) {
        const previousPath = source.path
        const saveResult = await source.assignPathAndSave(path, request.scene)
        if (saveResult.ok) {
          if (previousPath && pathKey(previousPath) !== key) {
            this.#paths.delete(pathKey(previousPath))
          }
          this.#paths.set(key, source.id)
          await this.#recordRecent(path)
        }
        return saveResult
      }

      const copy = this.#createController({ path, scene: request.scene })
      const saveResult = await copy.assignPathAndSave(path, request.scene)
      if (!saveResult.ok) {
        this.#documents.delete(copy.id)
        await copy.close()
        return saveResult
      }
      this.#paths.set(key, copy.id)
      this.#visibleDocuments.add(copy.id)
      await this.#recordRecent(path)
      const document = copy.document
      this.#onEvent({ type: 'opened', document })
      return { ok: true, document, createdCopy: true }
    } finally {
      this.#reservedPaths.delete(key)
    }
  }

  closeDocument(documentId: string): boolean {
    this.#require(documentId)
    this.#visibleDocuments.delete(documentId)
    return true
  }

  resetRendererVisibility(): void {
    this.#visibleDocuments.clear()
  }

  getDocument(documentId: string): OpenedDocument {
    return this.#require(documentId).document
  }

  async close(): Promise<void> {
    await Promise.all([...this.#documents.values()].map((document) => document.close()))
    this.#documents.clear()
    this.#paths.clear()
    this.#visibleDocuments.clear()
  }

  #createController(options: { path?: string; scene?: SaveRequest['scene'] }): DocumentController {
    const controller = new DocumentController({
      id: randomUUID(),
      ...options,
      onEvent: this.#onEvent
    })
    this.#documents.set(controller.id, controller)
    return controller
  }

  #require(documentId: string): DocumentController {
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new TypeError('A document ID is required')
    }
    const controller = this.#documents.get(documentId)
    if (!controller) {
      throw new Error('The requested document is not open')
    }
    return controller
  }

  async #recordRecent(path: string): Promise<void> {
    await this.#recentFiles.add(path)
    this.#onRecentFilesChanged()
  }
}
