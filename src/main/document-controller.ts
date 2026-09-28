import { readFile } from 'node:fs/promises'
import { atomicWriteFile } from './atomic-write'
import { ActiveFileWatcher, type FileWatcherEvent } from './file-watcher'
import { fingerprint } from './fingerprint'
import type { DocumentEvent, OpenedDocument, SaveResult } from '../shared/contracts'
import {
  cloneScene,
  parseSceneText,
  serializeScene,
  type ExcalidrawScene
} from '../shared/scene'

type ControllerOptions = {
  id: string
  path?: string
  scene?: ExcalidrawScene
  onEvent: (event: DocumentEvent) => void
}

export class DocumentController {
  readonly id: string
  readonly #onEvent: (event: DocumentEvent) => void
  #path: string | undefined
  #scene: ExcalidrawScene
  #fingerprint: string
  #watcher: ActiveFileWatcher | undefined

  constructor(options: ControllerOptions) {
    if (!options.path && !options.scene) {
      throw new TypeError('A document requires a path or an initial scene')
    }
    this.id = options.id
    this.#path = options.path
    this.#scene = cloneScene(options.scene ?? {
      type: 'excalidraw',
      version: 2,
      elements: [],
      appState: {},
      files: {}
    })
    this.#fingerprint = fingerprint(serializeScene(this.#scene))
    this.#onEvent = options.onEvent
  }

  get path(): string | undefined {
    return this.#path
  }

  get document(): OpenedDocument {
    return {
      id: this.id,
      path: this.#path ?? null,
      scene: cloneScene(this.#scene),
      fingerprint: this.#fingerprint
    }
  }

  async open(): Promise<OpenedDocument> {
    if (!this.#path) {
      return this.document
    }
    const content = await readFile(this.#path, 'utf8')
    this.#scene = parseSceneText(content)
    this.#fingerprint = fingerprint(content)
    await this.#replaceWatcher(this.#path, this.#fingerprint)
    return this.document
  }

  async reload(): Promise<boolean> {
    if (!this.#path) {
      return false
    }
    const document = await this.open()
    this.#onEvent({ type: 'opened', document })
    return true
  }

  async save(scene: ExcalidrawScene): Promise<SaveResult> {
    if (!this.#path) {
      return { ok: false, message: 'Choose a path before saving this document' }
    }
    return this.#writeScene(this.#path, scene)
  }

  async assignPathAndSave(path: string, scene: ExcalidrawScene): Promise<SaveResult> {
    const previousPath = this.#path
    this.#path = path
    const result = await this.#writeScene(path, scene)
    if (!result.ok) {
      this.#path = previousPath
    }
    return result
  }

  async close(): Promise<void> {
    await this.#watcher?.close()
    this.#watcher = undefined
  }

  async #writeScene(path: string, sceneCandidate: ExcalidrawScene): Promise<SaveResult> {
    let scene: ExcalidrawScene
    let content: string
    try {
      scene = parseSceneText(JSON.stringify(sceneCandidate))
      content = serializeScene(scene)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid save payload'
      this.#onEvent({
        type: 'save-failed',
        documentId: this.id,
        path: this.#path ?? null,
        message
      })
      return { ok: false, message }
    }

    const contentFingerprint = fingerprint(content)
    try {
      await atomicWriteFile(path, content)
      if (this.#watcher && this.#path === path) {
        this.#watcher.markOwnWrite(contentFingerprint)
      } else {
        await this.#replaceWatcher(path, contentFingerprint)
      }
      this.#path = path
      this.#scene = scene
      this.#fingerprint = contentFingerprint
      this.#onEvent({
        type: 'save-complete',
        documentId: this.id,
        path,
        fingerprint: contentFingerprint
      })
      return {
        ok: true,
        document: this.document,
        createdCopy: false
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save the file'
      this.#onEvent({
        type: 'save-failed',
        documentId: this.id,
        path,
        message
      })
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
      this.#scene = event.scene
      this.#fingerprint = event.fingerprint
      this.#onEvent({
        type: 'external-change',
        documentId: this.id,
        document: this.document
      })
    } else if (event.type === 'invalid') {
      this.#onEvent({
        type: 'invalid-external',
        documentId: this.id,
        path,
        message: event.message
      })
    } else {
      this.#onEvent({ type: 'file-missing', documentId: this.id, path })
    }
  }
}
