import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportImage } from '../src/main/export-image'
import { createEmptyScene } from '../src/shared/scene'
import type { DocumentRegistry } from '../src/main/document-registry'

const electronMocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: electronMocks
}))

const directories: string[] = []
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const webp = new TextEncoder().encode('RIFF1234WEBPmore-data')

const arrange = async () => {
  const directory = join(process.cwd(), 'tests', `.export-image-${randomUUID()}`)
  directories.push(directory)
  await mkdir(directory)
  const source = join(directory, 'sample.excalidraw')
  await writeFile(source, 'original drawing')
  const registry: Pick<DocumentRegistry, 'getDocument'> = {
    getDocument: (id) => {
      if (id !== 'document-id') {
        throw new Error('The requested document is not open')
      }
      return { id, path: source, scene: createEmptyScene(), fingerprint: 'original' }
    }
  }
  return { directory, source, registry }
}

beforeEach(() => electronMocks.showSaveDialog.mockReset())

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('image export', () => {
  it.each([
    ['svg', svg],
    ['png', png],
    ['webp', webp]
  ] as const)('saves %s beside the source without changing the drawing', async (format, data) => {
    const { directory, source, registry } = await arrange()
    const target = join(directory, `picture.${format}`)
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })

    const result = await exportImage({} as never, registry, {
      documentId: 'document-id', format, data
    })

    expect(result).toBe(true)
    expect(electronMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Export drawing',
        defaultPath: join(directory, `sample.${format}`),
        filters: [expect.objectContaining({ extensions: [format] })]
      })
    )
    expect(await readFile(target)).toEqual(Buffer.from(data))
    expect(await readFile(source, 'utf8')).toBe('original drawing')
  })

  it('appends the chosen extension instead of overwriting the .excalidraw file', async () => {
    const { source, registry } = await arrange()
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: source })

    expect(await exportImage({} as never, registry, {
      documentId: 'document-id', format: 'svg', data: svg
    })).toBe(true)

    expect(await readFile(`${source}.svg`)).toEqual(Buffer.from(svg))
    expect(await readFile(source, 'utf8')).toBe('original drawing')
  })

  it('cancels without writing a file', async () => {
    const { directory, registry } = await arrange()
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: true })

    expect(await exportImage({} as never, registry, {
      documentId: 'document-id', format: 'png', data: png
    })).toBe(false)
    await expect(readFile(join(directory, 'sample.png'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.each([
    { documentId: 'document-id', format: 'svg', data: png },
    { documentId: 'document-id', format: 'webp', data: png },
    { documentId: 'document-id', format: 'png', data: svg },
    { documentId: 'document-id', format: 'pdf', data: png },
    { documentId: 'document-id', format: 'svg', data: new Uint8Array() },
    { documentId: 'document-id', format: 'png', data: new Uint8Array(64 * 1024 * 1024 + 1) },
    { documentId: 'document-id', format: 'svg', data: 'not bytes' }
  ])('rejects malformed or oversized renderer payloads before opening a dialog', async (request) => {
    const { registry } = await arrange()

    await expect(exportImage({} as never, registry, request))
      .rejects.toThrow(TypeError)
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('requires a known document and an absolute destination', async () => {
    const { registry } = await arrange()
    await expect(exportImage({} as never, registry, {
      documentId: 'unknown', format: 'svg', data: svg
    })).rejects.toThrow('not open')
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()

    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false, filePath: 'relative.svg'
    })
    await expect(exportImage({} as never, registry, {
      documentId: 'document-id', format: 'svg', data: svg
    })).rejects.toThrow('Invalid export destination')
  })
})
