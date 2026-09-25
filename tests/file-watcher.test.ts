import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteFile } from '../src/main/atomic-write'
import {
  ActiveFileWatcher,
  type FileWatcherEvent
} from '../src/main/file-watcher'
import { fingerprint } from '../src/main/fingerprint'
import { serializeScene } from '../src/shared/scene'
import { element, scene } from './fixtures'

type Waiter = {
  predicate: (event: FileWatcherEvent) => boolean
  resolve: (event: FileWatcherEvent) => void
}

class EventCollector {
  readonly events: FileWatcherEvent[] = []
  readonly #waiters: Waiter[] = []

  push = (event: FileWatcherEvent): void => {
    this.events.push(event)
    const waiterIndex = this.#waiters.findIndex(({ predicate }) => predicate(event))
    if (waiterIndex >= 0) {
      const [waiter] = this.#waiters.splice(waiterIndex, 1)
      waiter?.resolve(event)
    }
  }

  next(predicate: (event: FileWatcherEvent) => boolean): Promise<FileWatcherEvent> {
    const existing = this.events.find(predicate)
    if (existing) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for watcher event: ${JSON.stringify(this.events)}`)),
        5000
      )
      this.#waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timeout)
          resolve(event)
        }
      })
    })
  }
}

const temporaryDirectories: string[] = []
const activeWatchers: ActiveFileWatcher[] = []

afterEach(async () => {
  await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.close()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

const arrangeWatcher = async (): Promise<{
  path: string
  watcher: ActiveFileWatcher
  collector: EventCollector
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'excalidraw-visualizer-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'drawing.excalidraw')
  const initialContent = serializeScene(scene([element('initial')]))
  await writeFile(path, initialContent, 'utf8')
  const collector = new EventCollector()
  const watcher = new ActiveFileWatcher(path, { onEvent: collector.push })
  activeWatchers.push(watcher)
  await watcher.start(fingerprint(initialContent))
  return { path, watcher, collector }
}

describe('ActiveFileWatcher', () => {
  it('detects a direct external write', async () => {
    const { path, collector } = await arrangeWatcher()
    await writeFile(path, serializeScene(scene([element('direct')])), 'utf8')

    const event = await collector.next((candidate) => candidate.type === 'scene')

    expect(event.type).toBe('scene')
    if (event.type === 'scene') {
      expect(event.scene.elements[0]?.id).toBe('direct')
    }
  })

  it('detects atomic replacement through rename', async () => {
    const { path, collector } = await arrangeWatcher()
    await atomicWriteFile(path, serializeScene(scene([element('atomic')])))

    const event = await collector.next((candidate) => candidate.type === 'scene')

    expect(event.type).toBe('scene')
    if (event.type === 'scene') {
      expect(event.scene.elements[0]?.id).toBe('atomic')
    }
  })

  it('keeps watching after invalid JSON and recovers when valid', async () => {
    const { path, collector } = await arrangeWatcher()
    await writeFile(path, '{"type":"excalidraw",', 'utf8')
    const invalid = await collector.next((candidate) => candidate.type === 'invalid')
    expect(invalid.type).toBe('invalid')

    await writeFile(path, serializeScene(scene([element('recovered')])), 'utf8')
    const recovered = await collector.next(
      (candidate) =>
        candidate.type === 'scene' && candidate.scene.elements[0]?.id === 'recovered'
    )

    expect(recovered.type).toBe('scene')
  })
})
