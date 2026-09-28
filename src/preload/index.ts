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
  openDialog: () =>
    ipcRenderer.invoke(ipcChannels.openDialog) as ReturnType<DesktopApi['openDialog']>,
  openPath: (path) =>
    ipcRenderer.invoke(ipcChannels.openPath, path) as ReturnType<DesktopApi['openPath']>,
  save: (request: SaveRequest) =>
    ipcRenderer.invoke(ipcChannels.save, request) as Promise<SaveResult>,
  saveAs: (request: SaveRequest) =>
    ipcRenderer.invoke(ipcChannels.saveAs, request) as Promise<SaveResult>,
  reload: (path) =>
    ipcRenderer.invoke(ipcChannels.reload, path) as ReturnType<DesktopApi['reload']>,
  closeDocument: (path) =>
    ipcRenderer.invoke(
      ipcChannels.closeDocument,
      path
    ) as ReturnType<DesktopApi['closeDocument']>,
  openInNewWindow: (path) =>
    ipcRenderer.invoke(
      ipcChannels.openInNewWindow,
      path
    ) as ReturnType<DesktopApi['openInNewWindow']>,
  setDirty: (dirty) => ipcRenderer.send(ipcChannels.setDirty, dirty),
  rendererReady: () =>
    ipcRenderer.invoke(ipcChannels.rendererReady) as ReturnType<DesktopApi['rendererReady']>,
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
