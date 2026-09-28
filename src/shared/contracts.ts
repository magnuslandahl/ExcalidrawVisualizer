import type { ExcalidrawScene } from './scene'
import type {
  AgentDeliveryInput,
  AgentDeliveryAttempt,
  AgentDeliveryResult,
  AgentDocumentState,
  AgentEvent,
  AgentPairingInput,
  AgentConnectionStatus
} from './agent-feedback'
import type {
  FeedbackDocumentState,
  LocalFeedback,
  LocalFeedbackSubmission,
  LocalFeedbackSubmissionInput
} from './feedback'

export const ipcChannels = {
  newDocument: 'document:new',
  openDialog: 'document:open-dialog',
  openPath: 'document:open-path',
  save: 'document:save',
  saveAs: 'document:save-as',
  reload: 'document:reload',
  closeDocument: 'document:close',
  openInNewWindow: 'document:open-in-new-window',
  setDirty: 'document:set-dirty',
  setActive: 'document:set-active',
  dictationTranscribe: 'dictation:transcribe',
  dictationCancel: 'dictation:cancel',
  feedbackList: 'feedback:list',
  feedbackUpsert: 'feedback:upsert',
  feedbackDelete: 'feedback:delete',
  feedbackSubmitCopy: 'feedback:submit-copy',
  feedbackCopySubmission: 'feedback:copy-submission',
  feedbackResolve: 'feedback:resolve',
  agentPair: 'agent-feedback:pair',
  agentUnpair: 'agent-feedback:unpair',
  agentStatus: 'agent-feedback:status',
  agentList: 'agent-feedback:list',
  agentDeliver: 'agent-feedback:deliver',
  agentRetireAttempt: 'agent-feedback:retire-attempt',
  companionStatus: 'copilot-companion:status',
  companionInstall: 'copilot-companion:install',
  appVersion: 'app:version',
  updateCheck: 'updates:check',
  updateInstall: 'updates:install',
  updateProgress: 'updates:progress',
  agentEvent: 'agent-feedback:event',
  rendererReady: 'app:renderer-ready',
  documentEvent: 'document:event',
  appCommand: 'app:command'
} as const

export type DictationLanguage = 'sv' | 'en' | 'auto'

export type DictationRequest = {
  jobId: string
  documentId: string
  draftId: string
  language: DictationLanguage
  wavData: Uint8Array
}

export type DictationResult =
  | {
      ok: true
      text: string
      detectedLanguage: string | null
    }
  | {
      ok: false
      canceled?: boolean
      message: string
    }

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
  id: string
  path: string | null
  scene: ExcalidrawScene
  fingerprint: string
}

export type DocumentEvent =
  | { type: 'opened'; document: OpenedDocument }
  | { type: 'activate'; documentId: string }
  | { type: 'external-change'; documentId: string; document: OpenedDocument }
  | { type: 'invalid-external'; documentId: string; path: string; message: string }
  | { type: 'file-missing'; documentId: string; path: string }
  | { type: 'save-complete'; documentId: string; path: string; fingerprint: string }
  | { type: 'save-failed'; documentId: string; path: string | null; message: string }

export type AppCommand =
  | { type: 'new' }
  | { type: 'open' }
  | { type: 'open-path'; path: string }
  | { type: 'save'; documentId: string | null }
  | { type: 'save-as'; documentId: string | null }
  | { type: 'reload'; documentId: string | null }
  | { type: 'fit-to-content'; documentId: string | null }

export type SaveRequest = {
  documentId: string
  scene: ExcalidrawScene
}

export type SaveResult =
  | {
      ok: true
      document: OpenedDocument
      createdCopy: boolean
      warning?: string
    }
  | { ok: false; canceled?: boolean; message?: string }

export type CopilotCompanionStatus = {
  state: 'not-installed' | 'current' | 'update-available' | 'unmanaged'
}

export type CopilotCompanionInstallResult = {
  status: CopilotCompanionStatus
  restartRequired: true
}

export type UpdateAssetReference = {
  selectionId: string
  name: string
  size: number
}

export type UpdateCheckResult = {
  checked: boolean
  currentVersion: string
  available: boolean
  installable: boolean
  latestVersion: string | null
  reason: string | null
  asset: UpdateAssetReference | null
  inPlace: boolean
}

export type UpdateInstallResult = {
  installed: boolean
  opened: boolean
  message: string | null
}

export type DesktopApi = {
  newDocument(): Promise<OpenedDocument>
  openDialog(): Promise<boolean>
  openPath(path: string): Promise<boolean>
  save(request: SaveRequest): Promise<SaveResult>
  saveAs(request: SaveRequest): Promise<SaveResult>
  reload(documentId: string): Promise<boolean>
  closeDocument(documentId: string): Promise<boolean>
  openInNewWindow(documentId: string): Promise<void>
  setDirty(documentId: string, dirty: boolean): void
  setActiveDocument(documentId: string | null): void
  transcribe(request: DictationRequest): Promise<DictationResult>
  cancelDictation(jobId: string): Promise<boolean>
  listFeedback(documentId: string): Promise<FeedbackDocumentState>
  upsertFeedback(draft: LocalFeedback): Promise<LocalFeedback>
  deleteFeedback(documentId: string, feedbackId: string): Promise<boolean>
  copyFeedbackSubmission(
    input: LocalFeedbackSubmissionInput
  ): Promise<LocalFeedbackSubmission>
  copyExistingFeedbackSubmission(
    documentId: string,
    submissionId: string
  ): Promise<void>
  resolveFeedback(
    documentId: string,
    feedbackId: string,
    updatedAt: string
  ): Promise<LocalFeedback>
  pairAgent(input: AgentPairingInput): Promise<AgentConnectionStatus>
  unpairAgent(): Promise<AgentConnectionStatus>
  getAgentStatus(): Promise<AgentConnectionStatus>
  listAgentActivity(documentId: string): Promise<AgentDocumentState>
  deliverFeedback(input: AgentDeliveryInput): Promise<AgentDeliveryResult>
  retireAgentAttempt(attemptId: string): Promise<AgentDeliveryAttempt>
  getCopilotCompanionStatus(): Promise<CopilotCompanionStatus>
  installCopilotCompanion(): Promise<CopilotCompanionInstallResult>
  getAppVersion(): Promise<string>
  checkForUpdates(): Promise<UpdateCheckResult>
  installUpdate(asset: UpdateAssetReference): Promise<UpdateInstallResult>
  rendererReady(): Promise<string[]>
  getDroppedFilePath(file: File): string
  onDocumentEvent(listener: (event: DocumentEvent) => void): () => void
  onAppCommand(listener: (command: AppCommand) => void): () => void
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
  onUpdateProgress(listener: (progress: number) => void): () => void
}
