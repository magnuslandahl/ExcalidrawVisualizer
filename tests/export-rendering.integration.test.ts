// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

afterEach(() => vi.restoreAllMocks())

describe('Excalidraw image rendering', () => {
  it('generates a real scalable SVG with an embedded rectangle', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ filter: 'none' } as CanvasRenderingContext2D)
    const [{ convertToExcalidrawElements, restore }, { renderExport }] = await Promise.all([
      import('@excalidraw/excalidraw'),
      import('../src/renderer/src/export-image')
    ])
    const restored = restore({
      elements: convertToExcalidrawElements([{
        type: 'rectangle', id: 'rectangle-one', x: 0, y: 0, width: 100, height: 80
      }]),
      appState: { viewBackgroundColor: '#ffffff' },
      files: {}
    }, null, null)
    const api: Pick<ExcalidrawImperativeAPI, 'getSceneElements' | 'getAppState' | 'getFiles'> = {
      getSceneElements: () => restored.elements,
      getAppState: () => ({
        ...restored.appState, width: 800, height: 600, offsetLeft: 0, offsetTop: 0
      }),
      getFiles: () => restored.files
    }

    const svg = new TextDecoder().decode(await renderExport(api, 'svg'))

    expect(svg).toMatch(/^<svg\b/)
    expect(svg).toContain('viewBox=')
    expect(svg).toContain('<path')
    expect(svg).toContain('#ffffff')
  })
})
