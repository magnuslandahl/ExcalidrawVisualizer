import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  ipcChannels,
  type AppCommand,
  type DesktopApi,
  type DictationRequest,
  type DictationResult,
  type DocumentEvent,
  type SaveRequest,
  type SaveResult
} from '../shared/contracts'
import type {
  LocalFeedback,
  LocalFeedbackSubmission,
  LocalFeedbackSubmissionInput
} from '../shared/feedback'
import type { AgentEvent } from '../shared/agent-feedback'

const api: DesktopApi = {
  newDocument: () =>
    ipcRenderer.invoke(ipcChannels.newDocument) as ReturnType<DesktopApi['newDocument']>,
  openDialog: () => ipcRenderer.invoke(ipcChannels.openDialog) as Promise<boolean>,
  openPath: (path) => ipcRenderer.invoke(ipcChannels.openPath, path) as Promise<boolean>,
  save: (request: SaveRequest) =>
    ipcRenderer.invoke(ipcChannels.save, request) as Promise<SaveResult>,
  saveAs: (request: SaveRequest) =>
    ipcRenderer.invoke(ipcChannels.saveAs, request) as Promise<SaveResult>,
  reload: (documentId) =>
    ipcRenderer.invoke(ipcChannels.reload, documentId) as Promise<boolean>,
  closeDocument: (documentId) =>
    ipcRenderer.invoke(ipcChannels.closeDocument, documentId) as Promise<boolean>,
  openInNewWindow: (documentId) =>
    ipcRenderer.invoke(ipcChannels.openInNewWindow, documentId) as Promise<void>,
  setDirty: (documentId, dirty) =>
    ipcRenderer.send(ipcChannels.setDirty, documentId, dirty),
  setActiveDocument: (documentId) =>
    ipcRenderer.send(ipcChannels.setActive, documentId),
  transcribe: (request: DictationRequest) =>
    ipcRenderer.invoke(
      ipcChannels.dictationTranscribe,
      request
    ) as Promise<DictationResult>,
  cancelDictation: (jobId) =>
    ipcRenderer.invoke(ipcChannels.dictationCancel, jobId) as Promise<boolean>,
  listFeedback: (documentId) =>
    ipcRenderer.invoke(
      ipcChannels.feedbackList,
      documentId
    ) as ReturnType<DesktopApi['listFeedback']>,
  upsertFeedback: (draft: LocalFeedback) =>
    ipcRenderer.invoke(
      ipcChannels.feedbackUpsert,
      draft
    ) as Promise<LocalFeedback>,
  deleteFeedback: (documentId, feedbackId) =>
    ipcRenderer.invoke(
      ipcChannels.feedbackDelete,
      documentId,
      feedbackId
    ) as Promise<boolean>,
  copyFeedbackSubmission: (input: LocalFeedbackSubmissionInput) =>
    ipcRenderer.invoke(
      ipcChannels.feedbackSubmitCopy,
      input
    ) as Promise<LocalFeedbackSubmission>,
  copyExistingFeedbackSubmission: (documentId, submissionId) =>
    ipcRenderer.invoke(
      ipcChannels.feedbackCopySubmission,
      documentId,
      submissionId
    ) as Promise<void>,
  resolveFeedback: (documentId, feedbackId, updatedAt) =>
    ipcRenderer.invoke(
      ipcChannels.feedbackResolve,
      documentId,
      feedbackId,
      updatedAt
    ) as Promise<LocalFeedback>,
  pairAgent: (input) =>
    ipcRenderer.invoke(ipcChannels.agentPair, input) as ReturnType<
      DesktopApi['pairAgent']
    >,
  unpairAgent: () =>
    ipcRenderer.invoke(ipcChannels.agentUnpair) as ReturnType<
      DesktopApi['unpairAgent']
    >,
  getAgentStatus: () =>
    ipcRenderer.invoke(ipcChannels.agentStatus) as ReturnType<
      DesktopApi['getAgentStatus']
    >,
  listAgentActivity: (documentId) =>
    ipcRenderer.invoke(ipcChannels.agentList, documentId) as ReturnType<
      DesktopApi['listAgentActivity']
    >,
  deliverFeedback: (input) =>
    ipcRenderer.invoke(ipcChannels.agentDeliver, input) as ReturnType<
      DesktopApi['deliverFeedback']
    >,
  retireAgentAttempt: (attemptId) =>
    ipcRenderer.invoke(
      ipcChannels.agentRetireAttempt,
      attemptId
    ) as ReturnType<DesktopApi['retireAgentAttempt']>,
  rendererReady: () =>
    ipcRenderer.invoke(ipcChannels.rendererReady) as Promise<string[]>,
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
  },
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void =>
      listener(payload)
    ipcRenderer.on(ipcChannels.agentEvent, handler)
    return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
