import { basename, join, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, session } from 'electron'
import { DictationService } from './dictation-service'
import { AgentFeedbackService } from './agent-feedback-service'
import { CopilotCompanionInstaller } from './copilot-companion-installer'
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
import {
  parseLocalFeedbackSubmissionInput,
  type FeedbackDocumentState,
  type LocalFeedback,
  type LocalFeedbackSubmission,
  type LocalFeedbackSubmissionInput
} from '../shared/feedback'
import {
  parseAgentPairingInput,
  type AgentDeliveryInput,
  type AgentEvent
} from '../shared/agent-feedback'

type WindowContext = {
  window: BrowserWindow
  registry: DocumentRegistry
  dirtyDocuments: Map<string, boolean>
  activeDocumentId: string | null
  allowClose: boolean
  pendingOpenPaths: string[]
  rendererReady: boolean
}

const windows = new Map<number, WindowContext>()
const agentDocumentRoutes = new Map<string, Map<number, string>>()
const pendingLaunchPaths: string[] = []
let feedbackStore: FeedbackStore | undefined
let agentFeedbackService: AgentFeedbackService | undefined
let copilotCompanionInstaller: CopilotCompanionInstaller | undefined
let dictationService: DictationService | undefined
let recentFiles: RecentFiles | undefined

const getExcalidrawPaths = (argv: readonly string[]): string[] =>
  argv.filter((argument) => argument.toLowerCase().endsWith('.excalidraw'))

const getPreferredWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ?? [...windows.values()].at(-1)?.window

const getPreferredContext = (): WindowContext | undefined => {
  const window = getPreferredWindow()
  return window ? windows.get(window.id) : undefined
}

const sendCommand = (window: BrowserWindow, command: AppCommand): void => {
  if (!window.isDestroyed()) {
    window.webContents.send(ipcChannels.appCommand, command)
  }
}

const sendDocumentEvent = (
  window: BrowserWindow,
  event: DocumentEvent
): void => {
  if (!window.isDestroyed()) {
    window.webContents.send(ipcChannels.documentEvent, event)
  }
}

const broadcastAgentEvent = (event: AgentEvent): void => {
  if (event.type === 'attempt') {
    const routes = agentDocumentRoutes.get(event.documentId)
    if (!routes) {
      return
    }
    for (const [windowId, documentId] of routes) {
      const context = windows.get(windowId)
      if (context && !context.window.isDestroyed()) {
        context.window.webContents.send(ipcChannels.agentEvent, {
          ...event,
          documentId,
          attempt: { ...event.attempt, documentId }
        })
      }
    }
    return
  }
  for (const context of windows.values()) {
    if (!context.window.isDestroyed()) {
      context.window.webContents.send(ipcChannels.agentEvent, event)
    }
  }
}

const registerAgentDocumentRoute = (
  context: WindowContext,
  storageDocumentId: string,
  publicDocumentId: string
): void => {
  const routes = agentDocumentRoutes.get(storageDocumentId) ?? new Map()
  routes.set(context.window.id, publicDocumentId)
  agentDocumentRoutes.set(storageDocumentId, routes)
}

const refreshApplicationMenu = (): void => {
  if (!recentFiles) {
    return
  }
  installApplicationMenu({
    getWindow: getPreferredWindow,
    getActiveDocumentId: () => getPreferredContext()?.activeDocumentId ?? null,
    recentFiles
  })
}

const attachWindowGuards = (context: WindowContext): void => {
  const { window } = context
  window.on('close', (event) => {
    if (
      ![...context.dirtyDocuments.values()].some(Boolean) ||
      context.allowClose
    ) {
      return
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'One or more drawings have unsaved changes or unresolved conflicts.',
      detail: 'Close this window without saving those changes?',
      buttons: ['Cancel', 'Close Without Saving'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 0) {
      event.preventDefault()
    } else {
      context.allowClose = true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}

const createWindow = (initialPaths: readonly string[] = []): BrowserWindow => {
  if (!recentFiles) {
    throw new Error('Recent files are not initialized')
  }
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

  const registry = new DocumentRegistry({
    getWindow: () => window,
    recentFiles,
    onEvent: (event) => sendDocumentEvent(window, event),
    onRecentFilesChanged: refreshApplicationMenu
  })
  const context: WindowContext = {
    window,
    registry,
    dirtyDocuments: new Map<string, boolean>(),
    activeDocumentId: null,
    allowClose: false,
    pendingOpenPaths: [...initialPaths],
    rendererReady: false
  }
  windows.set(window.id, context)
  attachWindowGuards(context)
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    windows.delete(window.id)
    for (const [storageDocumentId, routes] of agentDocumentRoutes) {
      routes.delete(window.id)
      if (routes.size === 0) {
        agentDocumentRoutes.delete(storageDocumentId)
      }
    }
    void context.registry.close()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

const requireWindowContext = (
  sender: Electron.WebContents
): WindowContext => {
  const window = BrowserWindow.fromWebContents(sender)
  const context = window ? windows.get(window.id) : undefined
  if (!context) {
    throw new Error('The application window is unavailable')
  }
  return context
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

const feedbackStorageKey = (
  context: WindowContext,
  documentId: string
): string => {
  const document = context.registry.getDocument(documentId)
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
  context: WindowContext,
  previousKey: string,
  result: SaveResult
): Promise<string | null> => {
  if (!result.ok || result.createdCopy || !feedbackStore) {
    return null
  }
  const nextKey = feedbackStorageKey(context, result.document.id)
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

const requireAgentDeliveryInput = (value: unknown): AgentDeliveryInput => {
  if (!value || typeof value !== 'object' || !('mode' in value)) {
    throw new TypeError('Invalid agent feedback delivery')
  }
  const { mode, ...submission } = value as Record<string, unknown>
  if (mode !== 'enqueue' && mode !== 'immediate') {
    throw new TypeError('Invalid agent feedback delivery mode')
  }
  return {
    ...parseLocalFeedbackSubmissionInput(submission),
    mode
  }
}

const registerIpc = (): void => {
  ipcMain.handle(ipcChannels.newDocument, (event) =>
    requireWindowContext(event.sender).registry.createDocument()
  )
  ipcMain.handle(ipcChannels.openDialog, (event) =>
    requireWindowContext(event.sender).registry.showOpenDialog()
  )
  ipcMain.handle(ipcChannels.openPath, (event, path: unknown) => {
    if (typeof path !== 'string') {
      throw new TypeError('Invalid file path')
    }
    return requireWindowContext(event.sender).registry.openPath(path)
  })
  ipcMain.handle(ipcChannels.save, async (event, request: unknown) => {
    const context = requireWindowContext(event.sender)
    const validRequest = requireSaveRequest(request)
    const previousKey = feedbackStorageKey(context, validRequest.documentId)
    const result = await context.registry.save(validRequest)
    const warning = await moveUntitledFeedbackAfterSave(
      context,
      previousKey,
      result
    )
    return result.ok && warning ? { ...result, warning } : result
  })
  ipcMain.handle(ipcChannels.saveAs, async (event, request: unknown) => {
    const context = requireWindowContext(event.sender)
    const validRequest = requireSaveRequest(request)
    const previousKey = feedbackStorageKey(context, validRequest.documentId)
    const result = await context.registry.saveAs(validRequest)
    const warning = await moveUntitledFeedbackAfterSave(
      context,
      previousKey,
      result
    )
    return result.ok && warning ? { ...result, warning } : result
  })
  ipcMain.handle(ipcChannels.reload, (event, documentId: unknown) =>
    requireWindowContext(event.sender).registry.reload(
      requireDocumentId(documentId)
    )
  )
  ipcMain.handle(ipcChannels.closeDocument, (event, documentId: unknown) => {
    const context = requireWindowContext(event.sender)
    const id = requireDocumentId(documentId)
    context.dirtyDocuments.delete(id)
    if (context.activeDocumentId === id) {
      context.activeDocumentId = null
    }
    return context.registry.closeDocument(id)
  })
  ipcMain.handle(ipcChannels.openInNewWindow, (event, documentId: unknown) => {
    const context = requireWindowContext(event.sender)
    const document = context.registry.getDocument(requireDocumentId(documentId))
    if (!document.path) {
      throw new Error('Save the drawing before moving it to another window')
    }
    createWindow([document.path])
  })
  ipcMain.on(ipcChannels.setDirty, (event, documentId: unknown, dirty: unknown) => {
    const id = requireDocumentId(documentId)
    if (typeof dirty !== 'boolean') {
      throw new TypeError('Invalid dirty state')
    }
    requireWindowContext(event.sender).dirtyDocuments.set(id, dirty)
  })
  ipcMain.on(ipcChannels.setActive, (event, documentId: unknown) => {
    if (documentId !== null && (typeof documentId !== 'string' || !documentId)) {
      throw new TypeError('Invalid active document ID')
    }
    requireWindowContext(event.sender).activeDocumentId = documentId
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
  ipcMain.handle(ipcChannels.feedbackList, async (event, documentId: unknown) => {
    if (!feedbackStore) {
      throw new Error('Feedback storage is unavailable')
    }
    const context = requireWindowContext(event.sender)
    const id = requireDocumentId(documentId)
    return exposeFeedbackState(
      await feedbackStore.list(feedbackStorageKey(context, id)),
      id
    )
  })
  ipcMain.handle(ipcChannels.feedbackUpsert, async (event, draft: unknown) => {
    if (!feedbackStore) {
      throw new Error('Feedback storage is unavailable')
    }
    const context = requireWindowContext(event.sender)
    if (!draft || typeof draft !== 'object') {
      throw new TypeError('Invalid feedback draft')
    }
    const publicDraft = draft as LocalFeedback
    const documentId = requireDocumentId(publicDraft.documentId)
    const stored = await feedbackStore.upsertDraft({
      ...publicDraft,
      documentId: feedbackStorageKey(context, documentId)
    })
    return exposeFeedback(stored, documentId)
  })
  ipcMain.handle(
    ipcChannels.feedbackDelete,
    (event, documentId: unknown, feedbackId: unknown) => {
      if (typeof feedbackId !== 'string') {
        throw new TypeError('Invalid feedback ID')
      }
      if (!feedbackStore) {
        throw new Error('Feedback storage is unavailable')
      }
      const context = requireWindowContext(event.sender)
      const id = requireDocumentId(documentId)
      return feedbackStore.deleteFeedback(
        feedbackStorageKey(context, id),
        feedbackId
      )
    }
  )
  ipcMain.handle(ipcChannels.feedbackSubmitCopy, async (event, input: unknown) => {
    if (!feedbackStore) {
      throw new Error('Feedback storage is unavailable')
    }
    const context = requireWindowContext(event.sender)
    if (!input || typeof input !== 'object') {
      throw new TypeError('Invalid feedback submission')
    }
    const publicInput = input as LocalFeedbackSubmissionInput
    const documentId = requireDocumentId(publicInput.documentId)
    const storedSubmission = await feedbackStore.createSubmission({
      ...publicInput,
      documentId: feedbackStorageKey(context, documentId)
    })
    const submission = exposeSubmission(storedSubmission, documentId)
    const document = context.registry.getDocument(documentId)
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
    async (event, documentId: unknown, submissionId: unknown) => {
      if (!feedbackStore || typeof submissionId !== 'string') {
        throw new Error('Feedback storage is unavailable')
      }
      const context = requireWindowContext(event.sender)
      const id = requireDocumentId(documentId)
      const state = await feedbackStore.list(feedbackStorageKey(context, id))
      const submission = state.submissions.find((item) => item.id === submissionId)
      if (!submission) {
        throw new Error('The saved feedback submission was not found')
      }
      const document = context.registry.getDocument(id)
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
      event,
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
      const context = requireWindowContext(event.sender)
      const id = requireDocumentId(documentId)
      return feedbackStore
        .markResolved(feedbackStorageKey(context, id), feedbackId, updatedAt)
        .then((item) => exposeFeedback(item, id))
    }
  )
  ipcMain.handle(ipcChannels.agentPair, (_event, input: unknown) => {
    if (!agentFeedbackService) {
      throw new Error('Agent feedback integration is unavailable')
    }
    return agentFeedbackService.pair(parseAgentPairingInput(input).pairingCode)
  })
  ipcMain.handle(ipcChannels.agentUnpair, () => {
    if (!agentFeedbackService) {
      throw new Error('Agent feedback integration is unavailable')
    }
    return agentFeedbackService.unpair()
  })
  ipcMain.handle(ipcChannels.agentStatus, () => {
    if (!agentFeedbackService) {
      throw new Error('Agent feedback integration is unavailable')
    }
    return agentFeedbackService.status
  })
  ipcMain.handle(ipcChannels.agentList, async (event, documentId: unknown) => {
    if (!agentFeedbackService || !feedbackStore) {
      throw new Error('Agent feedback integration is unavailable')
    }
    const context = requireWindowContext(event.sender)
    const id = requireDocumentId(documentId)
    const storageDocumentId = feedbackStorageKey(context, id)
    registerAgentDocumentRoute(context, storageDocumentId, id)
    const attempts =
      await feedbackStore.listAgentAttempts(storageDocumentId)
    return {
      connection: agentFeedbackService.status,
      attempts: attempts.map((attempt) => ({ ...attempt, documentId: id }))
    }
  })
  ipcMain.handle(ipcChannels.agentDeliver, async (event, input: unknown) => {
    if (!agentFeedbackService || !feedbackStore) {
      throw new Error('Agent feedback integration is unavailable')
    }
    const context = requireWindowContext(event.sender)
    const validInput = requireAgentDeliveryInput(input)
    const documentId = requireDocumentId(validInput.documentId)
    const document = context.registry.getDocument(documentId)
    const storageDocumentId = feedbackStorageKey(context, documentId)
    const { mode, ...submissionInput } = validInput
    const generation = await agentFeedbackService.preflight(mode)
    registerAgentDocumentRoute(context, storageDocumentId, documentId)
    const submission = exposeSubmission(
      await feedbackStore.createSubmission({
        ...submissionInput,
        documentId: storageDocumentId
      }),
      documentId
    )
    const storedSubmission = {
      ...submission,
      documentId: storageDocumentId,
      feedback: submission.feedback.map((item) => ({
        ...item,
        documentId: storageDocumentId
      }))
    }
    const attempt = await agentFeedbackService.dispatch({
      storageDocumentId,
      displayLabel: document.path ? basename(document.path) : 'Untitled drawing',
      submission: storedSubmission,
      mode,
      generation
    })
    if (attempt.status === 'rejected') {
      await feedbackStore.restoreSubmissionDrafts(
        storedSubmission.id,
        new Date().toISOString()
      )
    }
    return {
      submission,
      attempt: { ...attempt, documentId }
    }
  })
  ipcMain.handle(
    ipcChannels.agentRetireAttempt,
    async (_event, attemptId: unknown) => {
      if (!agentFeedbackService || typeof attemptId !== 'string') {
        throw new Error('Agent feedback integration is unavailable')
      }
      return agentFeedbackService.retireAttempt(attemptId)
    }
  )
  ipcMain.handle(ipcChannels.companionStatus, () => {
    if (!copilotCompanionInstaller) {
      throw new Error('The Copilot companion installer is unavailable')
    }
    return copilotCompanionInstaller.getStatus()
  })
  ipcMain.handle(ipcChannels.companionInstall, () => {
    if (!copilotCompanionInstaller) {
      throw new Error('The Copilot companion installer is unavailable')
    }
    return copilotCompanionInstaller.install()
  })
  ipcMain.handle(ipcChannels.rendererReady, (event) => {
    const context = requireWindowContext(event.sender)
    context.registry.resetRendererVisibility()
    context.rendererReady = true
    return context.pendingOpenPaths.splice(0)
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
        windows.has(BrowserWindow.fromWebContents(webContents)?.id ?? -1) &&
          permission === 'media' &&
          mediaTypes.length === 1 &&
          mediaTypes[0] === 'audio'
      )
    }
  )
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) => {
      return (
        webContents !== null &&
        windows.has(BrowserWindow.fromWebContents(webContents)?.id ?? -1) &&
        permission === 'media' &&
        details.mediaType === 'audio'
      )
    }
  )

  recentFiles = new RecentFiles(join(app.getPath('userData'), 'recent-files.json'))
  await recentFiles.load()
  feedbackStore = new FeedbackStore(
    join(app.getPath('userData'), 'feedback.sqlite'),
    join(app.getPath('userData'), 'feedback.json')
  )
  await feedbackStore.load()
  agentFeedbackService = new AgentFeedbackService(
    feedbackStore,
    broadcastAgentEvent
  )
  const companionSourceDirectory = app.isPackaged
    ? join(
        process.resourcesPath,
        'copilot-extension',
        'excalidraw-visualizer-companion'
      )
    : resolve(
        app.getAppPath(),
        '.github',
        'extensions',
        'excalidraw-visualizer-companion'
      )
  const copilotHome = process.env.COPILOT_HOME
    ? resolve(process.env.COPILOT_HOME)
    : join(app.getPath('home'), '.copilot')
  copilotCompanionInstaller = new CopilotCompanionInstaller(
    companionSourceDirectory,
    copilotHome
  )
  dictationService = new DictationService(
    join(app.getPath('userData'), 'dictation-temp')
  )
  await dictationService.initialize()

  pendingLaunchPaths.push(...getExcalidrawPaths(process.argv.slice(1)))
  registerIpc()
  createWindow(pendingLaunchPaths.splice(0))
  refreshApplicationMenu()
}

if (process.env.EXCALIDRAW_VISUALIZER_SMOKE_TEST === '1') {
  app.setName(`${app.getName()} Smoke Test`)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const paths = getExcalidrawPaths(argv)
    const window = getPreferredWindow()
    if (!window) {
      pendingLaunchPaths.push(...paths)
      return
    }
    const context = windows.get(window.id)
    for (const path of paths) {
      if (context?.rendererReady) {
        sendCommand(window, { type: 'open-path', path })
      } else {
        context?.pendingOpenPaths.push(path)
      }
    }
    if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
  })

  app.on('open-file', (event, path) => {
    event.preventDefault()
    const window = getPreferredWindow()
    const context = window ? windows.get(window.id) : undefined
    if (window && context?.rendererReady) {
      sendCommand(window, { type: 'open-path', path })
      window.focus()
    } else if (context) {
      context.pendingOpenPaths.push(path)
    } else {
      pendingLaunchPaths.push(path)
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
    if (windows.size === 0 && recentFiles) {
      createWindow(pendingLaunchPaths.splice(0))
    }
  })

  app.on('before-quit', () => {
    if (
      [...windows.values()].every(
        (context) => ![...context.dirtyDocuments.values()].some(Boolean)
      )
    ) {
      for (const context of windows.values()) {
        context.allowClose = true
      }
    }
  })

  app.on('will-quit', () => {
    for (const context of windows.values()) {
      void context.registry.close()
    }
    agentFeedbackService?.close()
    void dictationService?.close()
    feedbackStore?.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
