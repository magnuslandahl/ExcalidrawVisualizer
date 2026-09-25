import { readFile } from 'node:fs/promises'
import { dirname, normalize } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { fingerprint } from './fingerprint'
import { ContentFingerprintTracker } from './fingerprint-tracker'
import { parseSceneText, type ExcalidrawScene } from '../shared/scene'

export type FileWatcherEvent =
  | { type: 'scene'; scene: ExcalidrawScene; fingerprint: string }
  | { type: 'invalid'; message: string }
  | { type: 'missing' }

export type FileWatcherOptions = {
  onEvent: (event: FileWatcherEvent) => void
}

export class ActiveFileWatcher {
  readonly #targetPath: string
  readonly #onEvent: (event: FileWatcherEvent) => void
  #watcher: FSWatcher | undefined
  #fingerprints = new ContentFingerprintTracker()
  #processing = Promise.resolve()
  #missingTimer: ReturnType<typeof setTimeout> | undefined

  constructor(targetPath: string, options: FileWatcherOptions) {
    this.#targetPath = normalize(targetPath)
    this.#onEvent = options.onEvent
  }

  async start(initialFingerprint?: string): Promise<void> {
    this.#fingerprints = new ContentFingerprintTracker(initialFingerprint)
    this.#watcher = chokidar.watch(dirname(this.#targetPath), {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: 60,
        pollInterval: 15
      }
    })

    this.#watcher.on('all', (eventName, changedPath) => {
      if (normalize(changedPath) !== this.#targetPath) {
        return
      }

      if (eventName === 'unlink') {
        this.#scheduleMissingCheck()
        return
      }

      if (eventName === 'add' || eventName === 'change') {
        this.#cancelMissingCheck()
        this.#enqueueRead()
      }
    })

    await new Promise<void>((resolve, reject) => {
      const watcher = this.#watcher
      if (!watcher) {
        reject(new Error('Watcher did not initialize'))
        return
      }
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
  }

  markOwnWrite(contentFingerprint: string): void {
    this.#fingerprints.markOwnWrite(contentFingerprint)
  }

  async close(): Promise<void> {
    this.#cancelMissingCheck()
    await this.#processing
    await this.#watcher?.close()
    this.#watcher = undefined
  }

  #enqueueRead(): void {
    this.#processing = this.#processing.then(() => this.#readCurrent()).catch((error: unknown) => {
      this.#onEvent({
        type: 'invalid',
        message: error instanceof Error ? error.message : 'Unable to read the external file'
      })
    })
  }

  async #readCurrent(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.#targetPath, 'utf8')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        this.#onEvent({ type: 'missing' })
        return
      }
      throw error
    }

    const currentFingerprint = fingerprint(content)
    if (this.#fingerprints.shouldSuppress(currentFingerprint)) {
      return
    }

    try {
      const scene = parseSceneText(content)
      this.#fingerprints.acceptExternal(currentFingerprint)
      this.#onEvent({ type: 'scene', scene, fingerprint: currentFingerprint })
    } catch (error) {
      this.#onEvent({
        type: 'invalid',
        message: error instanceof Error ? error.message : 'Invalid Excalidraw document'
      })
    }
  }

  #scheduleMissingCheck(): void {
    this.#cancelMissingCheck()
    this.#missingTimer = setTimeout(() => {
      this.#missingTimer = undefined
      this.#enqueueRead()
    }, 120)
  }

  #cancelMissingCheck(): void {
    if (this.#missingTimer !== undefined) {
      clearTimeout(this.#missingTimer)
      this.#missingTimer = undefined
    }
  }
}
