import type { ExcalidrawScene } from './scene'

export const ipcChannels = {
  openDialog: 'document:open-dialog',
  openPath: 'document:open-path',
  save: 'document:save',
  saveAs: 'document:save-as',
  reload: 'document:reload',
  closeDocument: 'document:close',
  openInNewWindow: 'document:open-in-new-window',
  setDirty: 'document:set-dirty',
  rendererReady: 'app:renderer-ready',
  documentEvent: 'document:event',
  appCommand: 'app:command'
} as const

export type DocumentStatus =
  | 'no-file'
  | 'loading'
  | 'saved'
  | 'modified'
  | 'saving'
  | 'external-applied'
  | 'conflict'
  | 'invalid-external'
  | 'save-failed'
  | 'file-missing'

export type OpenedDocument = {
  path: string
  scene: ExcalidrawScene
  fingerprint: string
}

export type DocumentEvent =
  | { type: 'external-change'; document: OpenedDocument }
  | { type: 'invalid-external'; path: string; message: string }
  | { type: 'file-missing'; path: string }
  | { type: 'save-complete'; path: string; fingerprint: string }
  | { type: 'save-failed'; path: string; message: string }

export type AppCommand =
  | { type: 'open' }
  | { type: 'open-path'; path: string }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'reload' }
  | { type: 'fit-to-content' }

export type SaveRequest = {
  path: string
  scene: ExcalidrawScene
}

export type SaveResult =
  | { ok: true; path: string; fingerprint: string }
  | { ok: false; canceled?: boolean; message?: string }

export type DesktopApi = {
  openDialog(): Promise<OpenedDocument[]>
  openPath(path: string): Promise<OpenedDocument>
  save(request: SaveRequest): Promise<SaveResult>
  saveAs(request: SaveRequest): Promise<SaveResult>
  reload(path: string): Promise<OpenedDocument>
  closeDocument(path: string): Promise<void>
  openInNewWindow(path: string): Promise<void>
  setDirty(dirty: boolean): void
  rendererReady(): Promise<string[]>
  getDroppedFilePath(file: File): string
  onDocumentEvent(listener: (event: DocumentEvent) => void): () => void
  onAppCommand(listener: (command: AppCommand) => void): () => void
}
