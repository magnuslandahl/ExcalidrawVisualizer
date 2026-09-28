import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, session } from 'electron'
import { DictationService } from './dictation-service'
import { DocumentRegistry } from './document-registry'
import { FeedbackStore } from './feedback-store'
import { feedbackDocumentStorageKey } from './feedback-document'
import { installApplicationMenu } from './menu'
import { RecentFiles } from './recent-files'
import {
  ipcChannels,
  type AppCommand,
  type DocumentEvent,
  type SaveResult,
  type SaveRequest
} from '../shared/contracts'
import type {
  FeedbackDocumentState,
  LocalFeedback,
  LocalFeedbackSubmission,
  LocalFeedbackSubmissionInput
} from '../shared/feedback'

let mainWindow: BrowserWindow | undefined
let registry: DocumentRegistry | undefined
let feedbackStore: FeedbackStore | undefined
let dictationService: DictationService | undefined
const dirtyDocuments = new Map<string, boolean>()
let activeDocumentId: string | null = null
let allowQuit = false
let pendingOpenPath: string | undefined
let rendererReady = false

const getExcalidrawPath = (argv: readonly string[]): string | undefined =>
  argv.find((argument) => argument.toLowerCase().endsWith('.excalidraw'))

const sendCommand = (command: AppCommand): void => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.appCommand, command)
  }
}

const sendDocumentEvent = (event: DocumentEvent): void => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.documentEvent, event)
  }
}

const attachWindowGuards = (window: BrowserWindow): void => {
  window.on('close', (event) => {
    if (![...dirtyDocuments.values()].some(Boolean) || allowQuit) {
      return
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'This drawing has unsaved changes or an unresolved conflict.',
      detail: 'Quit without saving those changes?',
      buttons: ['Cancel', 'Quit Without Saving'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 0) {
      event.preventDefault()
    } else {
      allowQuit = true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: '#f8f9fb',
    title: 'Excalidraw Visualizer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  attachWindowGuards(window)
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
      rendererReady = false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const requireSaveRequest = (request: unknown): SaveRequest => {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('scene' in request) ||
    !('documentId' in request) ||
    typeof request.documentId !== 'string'
  ) {
    throw new TypeError('Invalid save request')
  }
  return request as SaveRequest
}

const requireDocumentId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Invalid document ID')
  }
  return value
}

const formatTarget = (feedback: LocalFeedback): string => {
  if (feedback.target.type === 'drawing') {
    return 'whole drawing'
  }
  if (feedback.target.type === 'elements') {
    return `elements ${feedback.target.elementIds.join(', ')}`
  }
  if (feedback.target.type === 'point') {
    return `point (${feedback.target.point.x}, ${feedback.target.point.y})`
  }
  const { x, y, width, height } = feedback.target.region
  return `region (${x}, ${y}, ${width} × ${height})`
}

const formatCopiedSubmission = (
  path: string | null,
  revision: string,
  feedback: readonly LocalFeedback[]
): string =>
  [
    `Visual feedback for ${path ?? 'an untitled Excalidraw drawing'}`,
    `Document revision: ${revision}`,
    '',
    ...feedback.flatMap((item, index) => [
      `${index + 1}. Target: ${formatTarget(item)}`,
      item.text
    ])
  ].join('\n')

const feedbackStorageKey = (documentId: string): string => {
  if (!registry) {
    throw new Error('Document storage is unavailable')
  }
  const document = registry.getDocument(documentId)
  return feedbackDocumentStorageKey(document)
}

const exposeFeedback = (
  feedback: LocalFeedback,
  documentId: string
): LocalFeedback => ({ ...feedback, documentId })

const exposeSubmission = (
  submission: LocalFeedbackSubmission,
  documentId: string
): LocalFeedbackSubmission => ({
  ...submission,
  documentId,
  feedback: submission.feedback.map((item) =>
    exposeFeedback(item, documentId)
  )
})

const exposeFeedbackState = (
  state: FeedbackDocumentState,
  documentId: string
): FeedbackDocumentState => ({
  feedback: state.feedback.map((item) => exposeFeedback(item, documentId)),
  submissions: state.submissions.map((item) =>
    exposeSubmission(item, documentId)
  )
})

const moveUntitledFeedbackAfterSave = async (
  previousKey: string,
  result: SaveResult
): Promise<string | null> => {
  if (!result.ok || result.createdCopy || !feedbackStore) {
    return null
  }
  const nextKey = feedbackStorageKey(result.document.id)
  if (nextKey !== previousKey) {
    try {
      await feedbackStore.moveDocument(previousKey, nextKey)
    } catch (error) {
      return `The drawing was saved, but its local feedback could not be linked to the new path: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
  return null
}

const registerIpc = (): void => {
  ipcMain.handle(ipcChannels.newDocument, () => registry?.createDocument())
  ipcMain.handle(ipcChannels.openDialog, () => registry?.showOpenDialog() ?? false)
  ipcMain.handle(ipcChannels.openPath, (_event, path: unknown) => {
    if (typeof path !== 'string') {
      throw new TypeError('Invalid file path')
    }
    return registry?.openPath(path) ?? false
  })
  ipcMain.handle(ipcChannels.save, async (_event, request: unknown) => {
    if (!registry) {
      throw new Error('Document storage is unavailable')
    }
    const validRequest = requireSaveRequest(request)
    const previousKey = feedbackStorageKey(validRequest.documentId)
    const result = await registry.save(validRequest)
    const warning = await moveUntitledFeedbackAfterSave(previousKey, result)
    return result.ok && warning ? { ...result, warning } : result
  })
  ipcMain.handle(ipcChannels.saveAs, async (_event, request: unknown) => {
    if (!registry) {
      throw new Error('Document storage is unavailable')
    }
    const validRequest = requireSaveRequest(request)
    const previousKey = feedbackStorageKey(validRequest.documentId)
    const result = await registry.saveAs(validRequest)
    const warning = await moveUntitledFeedbackAfterSave(previousKey, result)
    return result.ok && warning ? { ...result, warning } : result
  })
  ipcMain.handle(ipcChannels.reload, (_event, documentId: unknown) =>
    registry?.reload(requireDocumentId(documentId)) ?? false
  )
  ipcMain.handle(ipcChannels.close, (_event, documentId: unknown) => {
    const id = requireDocumentId(documentId)
    dirtyDocuments.delete(id)
    if (activeDocumentId === id) {
      activeDocumentId = null
    }
    return registry?.closeDocument(id) ?? false
  })
  ipcMain.on(ipcChannels.setDirty, (_event, documentId: unknown, dirty: unknown) => {
    const id = requireDocumentId(documentId)
    if (typeof dirty !== 'boolean') {
      throw new TypeError('Invalid dirty state')
    }
    dirtyDocuments.set(id, dirty)
  })
  ipcMain.on(ipcChannels.setActive, (_event, documentId: unknown) => {
    if (documentId !== null && (typeof documentId !== 'string' || !documentId)) {
      throw new TypeError('Invalid active document ID')
    }
    activeDocumentId = documentId
  })
  ipcMain.handle(ipcChannels.dictationTranscribe, (_event, request: unknown) => {
    if (!dictationService) {
      throw new Error('Dictation is unavailable')
    }
    return dictationService.transcribe(request)
  })
  ipcMain.handle(ipcChannels.dictationCancel, (_event, jobId: unknown) => {
    if (!dictationService) {
      throw new Error('Dictation is unavailable')
    }
    return dictationService.cancel(jobId)
  })
  ipcMain.handle(ipcChannels.feedbackList, async (_event, documentId: unknown) => {
    if (!feedbackStore) {
      throw new Error('Feedback storage is unavailable')
    }
    const id = requireDocumentId(documentId)
    return exposeFeedbackState(
      await feedbackStore.list(feedbackStorageKey(id)),
      id
    )
  })
  ipcMain.handle(ipcChannels.feedbackUpsert, async (_event, draft: unknown) => {
    if (!feedbackStore) {
      throw new Error('Feedback storage is unavailable')
    }
    if (!draft || typeof draft !== 'object') {
      throw new TypeError('Invalid feedback draft')
    }
    const publicDraft = draft as LocalFeedback
    const documentId = requireDocumentId(publicDraft.documentId)
    const stored = await feedbackStore.upsertDraft({
      ...publicDraft,
      documentId: feedbackStorageKey(documentId)
    })
    return exposeFeedback(stored, documentId)
  })
  ipcMain.handle(
    ipcChannels.feedbackDelete,
    (_event, documentId: unknown, feedbackId: unknown) => {
      if (typeof feedbackId !== 'string') {
        throw new TypeError('Invalid feedback ID')
      }
      if (!feedbackStore) {
        throw new Error('Feedback storage is unavailable')
      }
      const id = requireDocumentId(documentId)
      return feedbackStore.deleteFeedback(feedbackStorageKey(id), feedbackId)
    }
  )
  ipcMain.handle(ipcChannels.feedbackSubmitCopy, async (_event, input: unknown) => {
    if (!feedbackStore || !registry) {
      throw new Error('Feedback storage is unavailable')
    }
    if (!input || typeof input !== 'object') {
      throw new TypeError('Invalid feedback submission')
    }
    const publicInput = input as LocalFeedbackSubmissionInput
    const documentId = requireDocumentId(publicInput.documentId)
    const storedSubmission = await feedbackStore.createSubmission({
      ...publicInput,
      documentId: feedbackStorageKey(documentId)
    })
    const submission = exposeSubmission(storedSubmission, documentId)
    const document = registry.getDocument(documentId)
    clipboard.writeText(
      formatCopiedSubmission(
        document.path,
        submission.documentRevision,
        submission.feedback
      )
    )
    return submission
  })
  ipcMain.handle(
    ipcChannels.feedbackCopySubmission,
    async (_event, documentId: unknown, submissionId: unknown) => {
      if (!feedbackStore || !registry || typeof submissionId !== 'string') {
        throw new Error('Feedback storage is unavailable')
      }
      const id = requireDocumentId(documentId)
      const state = await feedbackStore.list(feedbackStorageKey(id))
      const submission = state.submissions.find((item) => item.id === submissionId)
      if (!submission) {
        throw new Error('The saved feedback submission was not found')
      }
      const document = registry.getDocument(id)
      clipboard.writeText(
        formatCopiedSubmission(
          document.path,
          submission.documentRevision,
          submission.feedback
        )
      )
    }
  )
  ipcMain.handle(
    ipcChannels.feedbackResolve,
    (
      _event,
      documentId: unknown,
      feedbackId: unknown,
      updatedAt: unknown
    ) => {
      if (typeof feedbackId !== 'string' || typeof updatedAt !== 'string') {
        throw new TypeError('Invalid feedback resolution')
      }
      if (!feedbackStore) {
        throw new Error('Feedback storage is unavailable')
      }
      const id = requireDocumentId(documentId)
      return feedbackStore
        .markResolved(feedbackStorageKey(id), feedbackId, updatedAt)
        .then((item) => exposeFeedback(item, id))
    }
  )
  ipcMain.handle(ipcChannels.rendererReady, () => {
    registry?.resetRendererVisibility()
    rendererReady = true
    const path = pendingOpenPath
    pendingOpenPath = undefined
    return path
  })
}

const initialize = async (): Promise<void> => {
  app.setAppUserModelId('com.excalidrawvisualizer.app')
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes =
        'mediaTypes' in details && Array.isArray(details.mediaTypes)
          ? details.mediaTypes
          : []
      callback(
        webContents === mainWindow?.webContents &&
          permission === 'media' &&
          mediaTypes.length === 1 &&
          mediaTypes[0] === 'audio'
      )
    }
  )
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) => {
      return (
        webContents === mainWindow?.webContents &&
        permission === 'media' &&
        details.mediaType === 'audio'
      )
    }
  )

  const recentFiles = new RecentFiles(join(app.getPath('userData'), 'recent-files.json'))
  await recentFiles.load()
  feedbackStore = new FeedbackStore(join(app.getPath('userData'), 'feedback.json'))
  await feedbackStore.load()
  dictationService = new DictationService(
    join(app.getPath('userData'), 'dictation-temp')
  )
  await dictationService.initialize()

  pendingOpenPath ??= getExcalidrawPath(process.argv.slice(1))
  registry = new DocumentRegistry({
    getWindow: () => mainWindow,
    recentFiles,
    onEvent: sendDocumentEvent,
    onRecentFilesChanged: () =>
      installApplicationMenu({
        getWindow: () => mainWindow,
        getActiveDocumentId: () => activeDocumentId,
        recentFiles
      })
  })
  registerIpc()
  mainWindow = createWindow()
  installApplicationMenu({
    getWindow: () => mainWindow,
    getActiveDocumentId: () => activeDocumentId,
    recentFiles
  })
}

if (process.env.EXCALIDRAW_VISUALIZER_SMOKE_TEST === '1') {
  app.setName(`${app.getName()} Smoke Test`)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
    const path = getExcalidrawPath(argv)
    if (path) {
      if (rendererReady) {
        sendCommand({ type: 'open-path', path })
      } else {
        pendingOpenPath = path
      }
    }
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (mainWindow && rendererReady) {
      sendCommand({ type: 'open-path', path })
    } else {
      pendingOpenPath = path
    }
  })

  app.whenReady().then(initialize).catch((error: unknown) => {
    dialog.showErrorBox(
      'Excalidraw Visualizer failed to start',
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      rendererReady = false
      mainWindow = createWindow()
    }
  })

  app.on('before-quit', () => {
    if (![...dirtyDocuments.values()].some(Boolean)) {
      allowQuit = true
    }
  })

  app.on('will-quit', () => {
    void registry?.close()
    void dictationService?.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
