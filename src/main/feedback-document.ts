import { createHash } from 'node:crypto'
import type { OpenedDocument } from '../shared/contracts'

export const feedbackDocumentStorageKey = (
  document: Pick<OpenedDocument, 'id' | 'path'>,
  platform = process.platform
): string => {
  const stablePath =
    platform === 'win32' ? document.path?.toLowerCase() : document.path
  return stablePath
    ? `path-${createHash('sha256').update(stablePath).digest('hex')}`
    : `untitled-${document.id}`
}
