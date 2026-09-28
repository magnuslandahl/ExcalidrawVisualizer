import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentRegistry } from '../src/main/document-registry'
import type { RecentFiles } from '../src/main/recent-files'
import type { DocumentEvent, OpenedDocument } from '../src/shared/contracts'
import { createEmptyScene } from '../src/shared/scene'

const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: electronMocks
}))

const testDirectories: string[] = []

const arrange = async (): Promise<{
  directory: string
  events: DocumentEvent[]
  recent: string[]
  registry: DocumentRegistry
}> => {
  const directory = join(process.cwd(), 'tests', `.document-registry-${randomUUID()}`)
  testDirectories.push(directory)
  await mkdir(directory, { recursive: true })
  const events: DocumentEvent[] = []
  const recent: string[] = []
  const recentFiles = {
    add: async (path: string) => {
      recent.push(path)
    }
  } as unknown as RecentFiles
  return {
    directory,
    events,
    recent,
    registry: new DocumentRegistry({
      getWindow: () => ({}) as never,
      recentFiles,
      onEvent: (event) => events.push(event),
      onRecentFilesChanged: () => undefined
    })
  }
}

const writeScene = async (path: string): Promise<void> => {
  await writeFile(path, `${JSON.stringify(createEmptyScene())}\n`, 'utf8')
}

const openedDocuments = (events: readonly DocumentEvent[]): OpenedDocument[] =>
  events.flatMap((event) => (event.type === 'opened' ? [event.document] : []))

beforeEach(() => {
  electronMocks.showOpenDialog.mockReset()
  electronMocks.showSaveDialog.mockReset()
})

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('DocumentRegistry', () => {
  it('opens multiple files and focuses a duplicate path without duplicating it', async () => {
    const { directory, events, registry } = await arrange()
    const first = join(directory, 'first.excalidraw')
    const second = join(directory, 'second.excalidraw')
    await Promise.all([writeScene(first), writeScene(second)])

    await registry.openPath(first)
    await registry.openPath(second)
    await registry.openPath(first)

    const opened = openedDocuments(events)
    expect(opened).toHaveLength(2)
    expect(events.at(-1)).toEqual({ type: 'activate', documentId: opened[0]?.id })
    await registry.close()
  })

  it('retains a closed file document and rereads it when reopened', async () => {
    const { directory, events, registry } = await arrange()
    const path = join(directory, 'retained.excalidraw')
    await writeScene(path)
    await registry.openPath(path)
    const documentId = openedDocuments(events)[0]!.id
    registry.closeDocument(documentId)
    const eventCount = events.length

    await registry.openPath(path)

    expect(openedDocuments(events.slice(eventCount))[0]?.id).toBe(documentId)
    expect(events.at(-1)).toEqual({ type: 'activate', documentId })
    await registry.close()
  })

  it('reopens retained documents after the renderer is recreated', async () => {
    const { directory, events, registry } = await arrange()
    const path = join(directory, 'renderer-recreated.excalidraw')
    await writeScene(path)
    await registry.openPath(path)
    const documentId = openedDocuments(events)[0]!.id
    registry.resetRendererVisibility()
    const eventCount = events.length

    await registry.openPath(path)

    expect(openedDocuments(events.slice(eventCount))[0]?.id).toBe(documentId)
    expect(events.at(-1)).toEqual({ type: 'activate', documentId })
    await registry.close()
  })

  it('assigns an untitled document its first save path without changing identity', async () => {
    const { directory, events, registry } = await arrange()
    const untitled = await registry.createDocument()
    const destination = join(directory, 'saved.excalidraw')
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: destination
    })

    const result = await registry.saveAs({
      documentId: untitled.id,
      scene: untitled.scene
    })

    expect(result).toMatchObject({
      ok: true,
      createdCopy: false,
      document: { id: untitled.id, path: destination }
    })
    expect(openedDocuments(events)).toHaveLength(1)
    expect(JSON.parse(await readFile(destination, 'utf8'))).toMatchObject({
      type: 'excalidraw',
      version: 2
    })
    await registry.close()
  })

  it('creates a separate document for Save As and rejects occupied destinations', async () => {
    const { directory, events, registry } = await arrange()
    const sourcePath = join(directory, 'source.excalidraw')
    const copyPath = join(directory, 'copy.excalidraw')
    await writeScene(sourcePath)
    await registry.openPath(sourcePath)
    const source = openedDocuments(events)[0]!
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: copyPath
    })

    const result = await registry.saveAs({
      documentId: source.id,
      scene: source.scene
    })
    expect(result.ok && result.createdCopy).toBe(true)
    if (!result.ok) {
      throw new Error('Expected Save As to succeed')
    }
    expect(result.document.id).not.toBe(source.id)
    expect(registry.getDocument(source.id).path).toBe(sourcePath)

    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: copyPath
    })
    await expect(
      registry.saveAs({ documentId: source.id, scene: source.scene })
    ).resolves.toMatchObject({
      ok: false,
      message: 'That path is already open or retained by another document'
    })
    await registry.close()
  })

  it('returns cancellation without creating or writing a destination', async () => {
    const { registry } = await arrange()
    const untitled = await registry.createDocument()
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: true })

    await expect(
      registry.saveAs({ documentId: untitled.id, scene: untitled.scene })
    ).resolves.toEqual({ ok: false, canceled: true })
    expect(registry.getDocument(untitled.id).path).toBeNull()
    await registry.close()
  })

  it('allows only one concurrent claim for a Save As destination', async () => {
    const { directory, registry } = await arrange()
    const first = await registry.createDocument()
    const second = await registry.createDocument()
    const destination = join(directory, 'claimed.excalidraw')
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: destination
    })

    const results = await Promise.all([
      registry.saveAs({ documentId: first.id, scene: first.scene }),
      registry.saveAs({ documentId: second.id, scene: second.scene })
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({
      message: 'Another save is already using that destination'
    })
    await registry.close()
  })

  it.skipIf(process.platform === 'win32')(
    'treats symlink aliases as one canonical document',
    async () => {
      const { directory, events, registry } = await arrange()
      const realPath = join(directory, 'real.excalidraw')
      const aliasPath = join(directory, 'alias.excalidraw')
      await writeScene(realPath)
      await symlink(realPath, aliasPath)

      await registry.openPath(realPath)
      await registry.openPath(aliasPath)

      expect(openedDocuments(events)).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('activate')
      await registry.close()
    }
  )
})
