import {
  exportToBlob,
  exportToSvg,
  getNonDeletedElements
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExportFormat } from '../../shared/contracts'

export const renderExport = async (
  api: Pick<ExcalidrawImperativeAPI, 'getSceneElements' | 'getAppState' | 'getFiles'>,
  format: ExportFormat
): Promise<Uint8Array> => {
  const elements = getNonDeletedElements(api.getSceneElements())
  if (elements.length === 0) {
    throw new Error('There are no elements to export')
  }
  const options = {
    elements,
    files: api.getFiles(),
    appState: {
      ...api.getAppState(),
      exportBackground: true,
      exportScale: 2
    }
  }
  if (format === 'svg') {
    const svg = await exportToSvg(options)
    return new TextEncoder().encode(new XMLSerializer().serializeToString(svg))
  }
  const image = await exportToBlob({
    ...options,
    mimeType: format === 'png' ? 'image/png' : 'image/webp'
  })
  const expectedType = format === 'png' ? 'image/png' : 'image/webp'
  if (image.type !== expectedType) {
    throw new Error(`The renderer cannot create a ${format.toUpperCase()} image`)
  }
  return new Uint8Array(await image.arrayBuffer())
}
