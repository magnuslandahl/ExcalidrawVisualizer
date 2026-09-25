import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  ipcChannels,
  type AppCommand,
  type DesktopApi,
  type DocumentEvent,
  type SaveRequest,
  type SaveResult
} from '../shared/contracts'

const api: DesktopApi = {
  openDialog: () => ipcRenderer.invoke(ipcChannels.openDialog) as Promise<boolean>,
  openPath: (path) => ipcRenderer.invoke(ipcChannels.openPath, path) as Promise<boolean>,
  save: (request: SaveRequest) =>
    ipcRenderer.invoke(ipcChannels.save, request) as Promise<SaveResult>,
  saveAs: (request: SaveRequest) =>
    ipcRenderer.invoke(ipcChannels.saveAs, request) as Promise<SaveResult>,
  reload: () => ipcRenderer.invoke(ipcChannels.reload) as Promise<boolean>,
  setDirty: (dirty) => ipcRenderer.send(ipcChannels.setDirty, dirty),
  rendererReady: () =>
    ipcRenderer.invoke(ipcChannels.rendererReady) as Promise<string | undefined>,
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  onDocumentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DocumentEvent): void =>
      listener(payload)
    ipcRenderer.on(ipcChannels.documentEvent, handler)
    return () => ipcRenderer.removeListener(ipcChannels.documentEvent, handler)
  },
  onAppCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppCommand): void =>
      listener(payload)
    ipcRenderer.on(ipcChannels.appCommand, handler)
    return () => ipcRenderer.removeListener(ipcChannels.appCommand, handler)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
