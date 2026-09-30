import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { renderExport } from '../src/renderer/src/export-image'

const exports = vi.hoisted(() => ({
  exportToSvg: vi.fn(),
  exportToBlob: vi.fn(),
  getNonDeletedElements: vi.fn((elements: { isDeleted?: boolean }[]) =>
    elements.filter((element) => !element.isDeleted))
}))

vi.mock('@excalidraw/excalidraw', () => exports)

const api = {
  getSceneElements: () => [{ id: 'visible' }, { id: 'deleted', isDeleted: true }],
  getFiles: () => ({ 'embedded-image': { id: 'embedded-image' } }),
  getAppState: () => ({ viewBackgroundColor: '#112233' })
} as unknown as ExcalidrawImperativeAPI

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('XMLSerializer', class {
    serializeToString() {
      return '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('render export', () => {
  it('generates vector SVG from visible elements with files and background', async () => {
    exports.exportToSvg.mockResolvedValue({})

    const result = await renderExport(api, 'svg')

    expect(new TextDecoder().decode(result)).toContain('<svg')
    expect(exports.exportToSvg).toHaveBeenCalledWith(expect.objectContaining({
      elements: [{ id: 'visible' }],
      files: api.getFiles(),
      appState: expect.objectContaining({
        viewBackgroundColor: '#112233',
        exportBackground: true,
        exportScale: 2
      })
    }))
    expect(exports.exportToBlob).not.toHaveBeenCalled()
  })

  it.each([
    ['png', 'image/png'],
    ['webp', 'image/webp']
  ] as const)('encodes %s as 2x %s raster data', async (format, mimeType) => {
    exports.exportToBlob.mockResolvedValue(new Blob(['image bytes'], { type: mimeType }))

    const result = await renderExport(api, format)

    expect(new TextDecoder().decode(result)).toBe('image bytes')
    expect(exports.exportToBlob).toHaveBeenCalledWith(expect.objectContaining({
      elements: [{ id: 'visible' }],
      files: api.getFiles(),
      appState: expect.objectContaining({
        exportBackground: true, exportScale: 2
      }),
      mimeType
    }))
  })

  it('rejects unsupported WebP encoding instead of saving disguised PNG', async () => {
    exports.exportToBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    await expect(renderExport(api, 'webp'))
      .rejects.toThrow('cannot create a WEBP image')
  })

  it('refuses empty drawings before asking the main process to write anything', async () => {
    exports.getNonDeletedElements.mockReturnValueOnce([])
    await expect(renderExport(api, 'svg'))
      .rejects.toThrow('There are no elements to export')
    expect(exports.exportToSvg).not.toHaveBeenCalled()
  })
})
