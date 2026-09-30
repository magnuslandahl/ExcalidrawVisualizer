import { basename, extname, isAbsolute } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { ExportFormat, ExportRequest } from '../shared/contracts'
import { atomicWriteFile } from './atomic-write'
import type { DocumentRegistry } from './document-registry'

const maxExportBytes = 64 * 1024 * 1024

const formats = {
  svg: { name: 'SVG vector images', signature: (data: Uint8Array) =>
    /^<svg(?:\s|>)/.test(Buffer.from(data.subarray(0, 200)).toString('utf8')) },
  png: { name: 'PNG images', signature: (data: Uint8Array) =>
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte) },
  webp: { name: 'WebP images', signature: (data: Uint8Array) =>
    Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP' }
} satisfies Record<ExportFormat, { name: string; signature: (data: Uint8Array) => boolean }>

const requireExportRequest = (value: unknown): ExportRequest => {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid export request')
  }
  const { documentId, format, data } = value as Record<string, unknown>
  if (typeof documentId !== 'string' || !documentId ||
      (format !== 'svg' && format !== 'png' && format !== 'webp') ||
      !(data instanceof Uint8Array) ||
      data.byteLength === 0 || data.byteLength > maxExportBytes ||
      !formats[format].signature(data)) {
    throw new TypeError('Invalid or oversized image export')
  }
  return { documentId, format, data }
}

export const exportImage = async (
  window: BrowserWindow,
  registry: Pick<DocumentRegistry, 'getDocument'>,
  input: unknown
): Promise<boolean> => {
  const { documentId, format, data } = requireExportRequest(input)
  const source = registry.getDocument(documentId)
  const defaultPath = source.path
    ? `${source.path.slice(0, -'.excalidraw'.length)}.${format}`
    : `Untitled.${format}`
  const result = await dialog.showSaveDialog(window, {
    title: 'Export drawing',
    defaultPath,
    filters: [{ name: formats[format].name, extensions: [format] }]
  })
  if (result.canceled || !result.filePath) {
    return false
  }
  const target = extname(result.filePath).toLowerCase() === `.${format}`
    ? result.filePath
    : `${result.filePath}.${format}`
  if (!isAbsolute(target) || basename(target) === `.${format}`) {
    throw new TypeError('Invalid export destination')
  }
  await atomicWriteFile(target, data)
  return true
}
