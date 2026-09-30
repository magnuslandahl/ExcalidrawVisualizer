import {
  CaptureUpdateAction,
  Excalidraw,
  restore,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState
} from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  downsampleMonoPcmTo16Khz,
  encodePcm16Wav,
  MAX_AUDIO_DURATION_SECONDS
} from '../../shared/audio'
import {
  mergeScenes,
  scenesEquivalent,
  valuesEquivalent,
  type MergeConflict
} from '../../shared/merge'
import { parseSceneText, type ExcalidrawScene } from '../../shared/scene'
import type {
  AppCommand,
  CopilotCompanionStatus,
  DictationLanguage,
  DocumentEvent,
  DocumentStatus,
  OpenedDocument,
  UpdateCheckResult
} from '../../shared/contracts'
import {
  MAX_FEEDBACK_INTERACTION_EVENTS,
  type FeedbackBounds,
  type FeedbackDocumentState,
  type FeedbackInteraction,
  type FeedbackTarget,
  type LocalFeedback
} from '../../shared/feedback'
import type {
  AgentConnectionStatus,
  AgentDeliveryMode,
  AgentDocumentState
} from '../../shared/agent-feedback'

type ConflictState = {
  base: ExcalidrawScene
  local: ExcalidrawScene
  external: ExcalidrawScene
  details: MergeConflict
  externalFingerprint: string
}

type EditorSeed = {
  key: number
  scene: ExcalidrawScene
}

type ThemePreference = 'system' | 'light' | 'dark'
type Theme = 'light' | 'dark'
type PaneId = 'primary' | 'secondary'
type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error'

type TabEntry = {
  document: OpenedDocument
  event: DocumentEvent | null
  eventVersion: number
  pane: PaneId
}

type EditorMeta = {
  path: string | null
  status: DocumentStatus
  dirty: boolean
  feedbackCount: number
  feedbackLoaded: boolean
  feedbackActive: boolean
}

type EditorCommand = {
  version: number
  type: 'save' | 'save-as' | 'reload' | 'fit-to-content'
}

type DocumentEditorProps = {
  document: OpenedDocument
  event: DocumentEvent | null
  eventVersion: number
  command: EditorCommand | null
  active: boolean
  focused: boolean
  theme: Theme
  onMetaChange: (documentId: string, meta: EditorMeta) => void
}

type ContextMenuState = {
  documentId: string
  x: number
  y: number
}

type RecordingSession = {
  audioContext: AudioContext
  processor: AudioWorkletNode
  source: MediaStreamAudioSourceNode
  stream: MediaStream
  chunks: Float32Array[]
  sourceSampleRate: number
  draftId: string
  timeout?: ReturnType<typeof setTimeout>
}

type FeedbackDraftSnapshot = {
  text: string
  target: FeedbackTarget
  interactionTrace: FeedbackInteraction[]
}

type PointerUpdate = {
  pointer: {
    x: number
    y: number
    tool: 'pointer' | 'laser'
  }
  button: 'down' | 'up'
}

type PointerSample = {
  at: number
  point: FeedbackInteraction['point']
  elementIds: string[]
}

const themePreferenceStorageKey = 'excalidraw-visualizer-theme'
const defaultCanvasBackground = '#ffffff'
const disconnectedAgentStatus: AgentConnectionStatus = {
  paired: false,
  readiness: 'disconnected',
  sessionId: null,
  generation: null,
  blockedReason: null,
  lastEventSequence: 0,
  detail: null
}

const statusLabels: Record<DocumentStatus, string> = {
  'no-file': 'No file open',
  loading: 'Loading',
  saved: 'Saved',
  modified: 'Modified',
  saving: 'Saving',
  'external-applied': 'External update applied',
  conflict: 'Conflict',
  'invalid-external': 'Invalid external file',
  'save-failed': 'Save failed',
  'file-missing': 'File missing'
}

const preservedAppStateKeys = [
  'scrollX',
  'scrollY',
  'zoom',
  'selectedElementIds',
  'selectedGroupIds',
  'editingGroupId',
  'activeTool',
  'openSidebar',
  'openMenu',
  'openDialog'
] as const

const toScene = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles
): ExcalidrawScene => parseSceneText(serializeAsJSON(elements, appState, files, 'local'))

const normalizeScene = (
  scene: ExcalidrawScene,
  localAppState: Partial<AppState> | null = null
): ExcalidrawScene => {
  const restored = restore(
    scene as unknown as ExcalidrawInitialDataState,
    localAppState,
    null
  )
  return toScene(restored.elements, restored.appState as AppState, restored.files)
}

const preserveViewport = (appState: AppState): Partial<AppState> =>
  Object.fromEntries(
    preservedAppStateKeys.map((key) => [key, appState[key]])
  ) as Partial<AppState>

const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : 'The operation failed'

const readThemePreference = (): ThemePreference => {
  const stored = window.localStorage.getItem(themePreferenceStorageKey)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

const readCanvasBackground = (scene: ExcalidrawScene): string => {
  const color = scene.appState.viewBackgroundColor
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : defaultCanvasBackground
}

const documentName = (path: string | null): string =>
  path ? (path.split(/[\\/]/).at(-1) ?? path) : 'Untitled'

const targetLabel = (target: FeedbackTarget): string => {
  if (target.type === 'drawing') {
    return 'Whole drawing'
  }
  if (target.type === 'elements') {
    return `${target.elementIds.length} selected element${
      target.elementIds.length === 1 ? '' : 's'
    }`
  }
  if (target.type === 'point') {
    return `Point ${Math.round(target.point.x)}, ${Math.round(target.point.y)}`
  }
  return `Region ${Math.round(target.region.width)} × ${Math.round(
    target.region.height
  )}`
}

const boundsMapsEqual = (
  left: Record<string, FeedbackBounds>,
  right: Record<string, FeedbackBounds>
): boolean => {
  const leftIds = Object.keys(left)
  if (leftIds.length !== Object.keys(right).length) {
    return false
  }
  return leftIds.every((id) => {
    const leftBounds = left[id]
    const rightBounds = right[id]
    return (
      leftBounds !== undefined &&
      rightBounds !== undefined &&
      leftBounds.x === rightBounds.x &&
      leftBounds.y === rightBounds.y &&
      leftBounds.width === rightBounds.width &&
      leftBounds.height === rightBounds.height
    )
  })
}

const elementFeedbackTarget = (
  elements: readonly OrderedExcalidrawElement[],
  selectedIds: ReadonlySet<string>
): Extract<FeedbackTarget, { type: 'elements' }> | null => {
  const visibleElements = elements.filter((element) => !element.isDeleted)
  const targetIds = new Set(selectedIds)
  for (const element of visibleElements) {
    if (targetIds.has(element.id) && 'boundElements' in element) {
      for (const binding of element.boundElements ?? []) {
        targetIds.add(binding.id)
      }
    }

    if (
      'containerId' in element &&
      typeof element.containerId === 'string' &&
      targetIds.has(element.containerId)
    ) {
      targetIds.add(element.id)
    }
  }
  const targets = visibleElements.filter((element) => targetIds.has(element.id))
  if (targets.length === 0) {
    return null
  }
  const minX = Math.min(...targets.map((element) => element.x))
  const minY = Math.min(...targets.map((element) => element.y))
  const maxX = Math.max(...targets.map((element) => element.x + element.width))
  const maxY = Math.max(...targets.map((element) => element.y + element.height))
  return {
    type: 'elements',
    elementIds: targets.map((element) => element.id),
    originalBounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    }
  }
}

const elementIdsAtPoint = (
  elements: readonly OrderedExcalidrawElement[],
  point: FeedbackInteraction['point']
): string[] =>
  elements
    .filter(
      (element) =>
        !element.isDeleted &&
        point.x >= element.x &&
        point.x <= element.x + element.width &&
        point.y >= element.y &&
        point.y <= element.y + element.height
    )
    .slice(-16)
    .reverse()
    .map((element) => element.id)

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

// Excalidraw calls onChange after prop updates, so repeated targets must not trigger a new render.
const sameElementFeedbackTarget = (
  current: FeedbackTarget,
  next: Extract<FeedbackTarget, { type: 'elements' }>
): boolean =>
  current.type === 'elements' &&
  sameIds(current.elementIds, next.elementIds) &&
  current.originalBounds.x === next.originalBounds.x &&
  current.originalBounds.y === next.originalBounds.y &&
  current.originalBounds.width === next.originalBounds.width &&
  current.originalBounds.height === next.originalBounds.height

function DocumentEditor({
  document,
  event,
  eventVersion,
  command,
  active,
  focused,
  theme,
  onMetaChange
}: DocumentEditorProps): React.JSX.Element {
  const initialScene = useMemo(() => normalizeScene(document.scene), [document])
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const baseSceneRef = useRef<ExcalidrawScene>(initialScene)
  const currentSceneRef = useRef<ExcalidrawScene>(initialScene)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const conflictRef = useRef<ConflictState | null>(null)
  const applyingRef = useRef(false)
  const pathRef = useRef<string | null>(document.path)
  const fingerprintRef = useRef(document.fingerprint)
  const handledEventVersionRef = useRef(0)
  const handledCommandVersionRef = useRef(0)
  const recordingRef = useRef<RecordingSession | null>(null)
  const recordingStartRef = useRef<object | null>(null)
  const dictationJobIdRef = useRef<string | null>(null)
  const recordingTargetIdsRef = useRef(new Set<string>())
  const interactionTraceRef = useRef<FeedbackInteraction[]>([])
  const recordingStartedAtRef = useRef<number | null>(null)
  const lastPointerButtonRef = useRef<'down' | 'up'>('up')
  const lastPointerSampleRef = useRef<PointerSample | null>(null)
  const draftTextRef = useRef('')
  const feedbackZenModeRef = useRef<boolean | null>(null)

  const [path, setPath] = useState<string | null>(document.path)
  const [status, setStatus] = useState<DocumentStatus>('saved')
  const [detail, setDetail] = useState<string | null>(null)
  const [dirty, setDirtyState] = useState(false)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [editorSeed, setEditorSeed] = useState<EditorSeed>({
    key: 1,
    scene: initialScene
  })
  const [feedbackLoaded, setFeedbackLoaded] = useState(false)
  const [canvasBackground, setCanvasBackground] = useState(
    readCanvasBackground(initialScene)
  )
  const [feedbackState, setFeedbackState] = useState<FeedbackDocumentState>({
    feedback: [],
    submissions: []
  })
  const [agentState, setAgentState] = useState<AgentDocumentState>({
    connection: disconnectedAgentStatus,
    attempts: []
  })
  const [companionStatus, setCompanionStatus] =
    useState<CopilotCompanionStatus | null>(null)
  const [companionBusy, setCompanionBusy] = useState(false)
  const [pairingCode, setPairingCode] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const [feedbackPanelOpen, setFeedbackPanelOpen] = useState(false)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID())
  const [draftCreatedAt, setDraftCreatedAt] = useState(() =>
    new Date().toISOString()
  )
  const [draftTarget, setDraftTarget] = useState<FeedbackTarget>({
    type: 'drawing'
  })
  const [draftText, setDraftText] = useState('')
  const draftIdRef = useRef(draftId)
  const [interactionEventCount, setInteractionEventCount] = useState(0)
  const [overlayViewport, setOverlayViewport] = useState({
    scrollX: 0,
    scrollY: 0,
    zoom: 1
  })
  const [sceneElementBounds, setSceneElementBounds] = useState<
    Record<string, FeedbackBounds>
  >({})
  const [dictationLanguage, setDictationLanguage] =
    useState<DictationLanguage>('auto')
  const [dictationState, setDictationState] = useState<
    'idle' | 'starting' | 'recording' | 'transcribing'
  >('idle')

  useEffect(() => {
    draftIdRef.current = draftId
  }, [draftId])

  useEffect(() => {
    draftTextRef.current = draftText
  }, [draftText])

  useEffect(() => {
    const api = apiRef.current
    if (!api) {
      return
    }
    if (feedbackPanelOpen) {
      if (feedbackZenModeRef.current === null) {
        feedbackZenModeRef.current = api.getAppState().zenModeEnabled
      }
      api.updateScene({
        appState: {
          ...api.getAppState(),
          zenModeEnabled: true
        },
        captureUpdate: CaptureUpdateAction.NEVER
      })
      return
    }
    if (feedbackZenModeRef.current !== null) {
      api.updateScene({
        appState: {
          ...api.getAppState(),
          zenModeEnabled: feedbackZenModeRef.current
        },
        captureUpdate: CaptureUpdateAction.NEVER
      })
      feedbackZenModeRef.current = null
    }
  }, [feedbackPanelOpen])

  const setDirty = useCallback(
    (nextDirty: boolean): void => {
      dirtyRef.current = nextDirty
      setDirtyState(nextDirty)
      window.desktop.setDirty(
        document.id,
        nextDirty || conflictRef.current !== null
      )
    },
    [document.id]
  )

  const setTemporaryStatus = useCallback(
    (nextStatus: DocumentStatus, duration = 2400): void => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current)
      }
      setStatus(nextStatus)
      statusTimerRef.current = setTimeout(() => {
        setStatus(dirtyRef.current ? 'modified' : 'saved')
        statusTimerRef.current = null
      }, duration)
    },
    []
  )

  const scheduleSaveRef = useRef<() => void>(() => undefined)

  const saveCurrent = useCallback(
    async (saveAs = false): Promise<boolean> => {
      const scene = currentSceneRef.current
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }

      setStatus('saving')
      setDetail(null)
      const request = { documentId: document.id, scene }
      const result = saveAs
        ? await window.desktop.saveAs(request)
        : await window.desktop.save(request)

      if (!result.ok) {
        if (result.canceled) {
          setStatus(dirtyRef.current ? 'modified' : 'saved')
        } else {
          setStatus('save-failed')
          setDetail(result.message ?? 'Unable to save the drawing')
          setDirty(true)
        }
        return false
      }

      if (result.createdCopy) {
        setStatus(dirtyRef.current ? 'modified' : 'saved')
        return true
      }

      pathRef.current = result.document.path
      fingerprintRef.current = result.document.fingerprint
      setPath(result.document.path)
      baseSceneRef.current = scene
      const unchangedDuringSave = scenesEquivalent(currentSceneRef.current, scene)
      setDirty(!unchangedDuringSave)
      setStatus(unchangedDuringSave ? 'saved' : 'modified')
      if (result.warning) {
        setDetail(result.warning)
      }
      if (!unchangedDuringSave) {
        scheduleSaveRef.current()
      }
      return true
    },
    [document.id, setDirty]
  )

  const scheduleSave = useCallback((): void => {
    if (!pathRef.current || conflictRef.current) {
      return
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void saveCurrent(false)
    }, 850)
  }, [saveCurrent])

  useEffect(() => {
    scheduleSaveRef.current = scheduleSave
  }, [scheduleSave])

  const applyToEditor = useCallback((
    scene: ExcalidrawScene,
    previousScene: ExcalidrawScene
  ): void => {
    const api = apiRef.current
    if (!api) {
      return
    }
    const currentAppState = api.getAppState()
    if (!valuesEquivalent(previousScene.files, scene.files)) {
      setEditorSeed((current) => ({
        key: current.key + 1,
        scene: {
          ...scene,
          appState: {
            ...scene.appState,
            ...preserveViewport(currentAppState)
          }
        }
      }))
      return
    }
    const restored = restore(
      scene as unknown as ExcalidrawInitialDataState,
      currentAppState,
      null
    )
    applyingRef.current = true
    api.addFiles(Object.values(restored.files))
    api.updateScene({
      elements: restored.elements,
      appState: {
        ...restored.appState,
        ...preserveViewport(currentAppState)
      } as AppState,
      captureUpdate: CaptureUpdateAction.NEVER
    })
    queueMicrotask(() => {
      applyingRef.current = false
    })
  }, [])

  const openDocument = useCallback(
    (opened: OpenedDocument): void => {
      const normalized = normalizeScene(opened.scene)
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      pathRef.current = opened.path
      fingerprintRef.current = opened.fingerprint
      baseSceneRef.current = normalized
      currentSceneRef.current = normalized
      conflictRef.current = null
      setPath(opened.path)
      setConflict(null)
      setDetail(null)
      setDirty(false)
      setStatus('saved')
      setCanvasBackground(readCanvasBackground(normalized))
      setEditorSeed((current) => ({
        key: current.key + 1,
        scene: normalized
      }))
    },
    [setDirty]
  )

  const handleExternalChange = useCallback(
    (opened: OpenedDocument): void => {
      const external = normalizeScene(
        opened.scene,
        apiRef.current?.getAppState() ?? null
      )
      const base = baseSceneRef.current
      const local = currentSceneRef.current

      if (!dirtyRef.current) {
        fingerprintRef.current = opened.fingerprint
        baseSceneRef.current = external
        currentSceneRef.current = external
        setCanvasBackground(readCanvasBackground(external))
        applyToEditor(external, local)
        setDetail(null)
        setDirty(false)
        setTemporaryStatus('external-applied')
        return
      }

      const result = mergeScenes(base, local, external)
      if (result.kind === 'merged') {
        fingerprintRef.current = opened.fingerprint
        baseSceneRef.current = external
        currentSceneRef.current = result.scene
        setCanvasBackground(readCanvasBackground(result.scene))
        applyToEditor(result.scene, local)
        setDetail(null)
        const remainsDirty = !scenesEquivalent(result.scene, external)
        setDirty(remainsDirty)
        setTemporaryStatus('external-applied')
        if (remainsDirty) {
          scheduleSave()
        }
        return
      }

      const nextConflict: ConflictState = {
        base,
        local,
        external,
        details: result.conflict,
        externalFingerprint: opened.fingerprint
      }
      conflictRef.current = nextConflict
      setConflict(nextConflict)
      setStatus('conflict')
      setDetail(null)
      setDirty(true)
    },
    [applyToEditor, scheduleSave, setDirty, setTemporaryStatus]
  )

  const reload = useCallback(async (): Promise<void> => {
    if (!pathRef.current) {
      return
    }
    if (
      (dirtyRef.current || conflictRef.current) &&
      !window.confirm('Discard local changes and reload this file from disk?')
    ) {
      return
    }
    setStatus('loading')
    setDetail(null)
    try {
      await window.desktop.reload(document.id)
    } catch (error) {
      setStatus('save-failed')
      setDetail(messageFromError(error))
    }
  }, [document.id])

  useEffect(() => {
    let canceled = false
    void window.desktop
      .listAgentActivity(document.id)
      .then((nextState) => {
        if (!canceled) {
          setAgentState(nextState)
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setFeedbackError(messageFromError(error))
        }
      })
    const removeListener = window.desktop.onAgentEvent((event) => {
      if (event.type === 'connection') {
        setAgentState((current) => ({
          ...current,
          connection: event.connection
        }))
      } else if (event.documentId === document.id) {
        setAgentState((current) => ({
          ...current,
          attempts: [
            event.attempt,
            ...current.attempts.filter(
              (attempt) => attempt.id !== event.attempt.id
            )
          ]
        }))
      }
    })
    return () => {
      canceled = true
      removeListener()
    }
  }, [document.id])

  useEffect(() => {
    let canceled = false
    void window.desktop
      .getCopilotCompanionStatus()
      .then((status) => {
        if (!canceled) {
          setCompanionStatus(status)
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setFeedbackError(messageFromError(error))
        }
      })
    return () => {
      canceled = true
    }
  }, [])

  const fitToContent = useCallback((): void => {
    const api = apiRef.current
    if (api) {
      api.scrollToContent(api.getSceneElements(), {
        fitToContent: true,
        animate: true,
        duration: 250
      })
    }
  }, [])

  useEffect(() => {
    if (!event || eventVersion <= handledEventVersionRef.current) {
      return
    }
    handledEventVersionRef.current = eventVersion
    queueMicrotask(() => {
      if (event.type === 'opened' && event.document.id === document.id) {
        openDocument(event.document)
      } else if (
        event.type === 'external-change' &&
        event.documentId === document.id
      ) {
        handleExternalChange(event.document)
      } else if (
        event.type === 'invalid-external' &&
        event.documentId === document.id
      ) {
        setStatus('invalid-external')
        setDetail(event.message)
      } else if (
        event.type === 'file-missing' &&
        event.documentId === document.id
      ) {
        setStatus('file-missing')
        setDetail('This file was deleted. Watching for it to be recreated.')
      } else if (
        event.type === 'save-failed' &&
        event.documentId === document.id
      ) {
        setStatus('save-failed')
        setDetail(event.message)
        setDirty(true)
      }
    })
  }, [
    document.id,
    event,
    eventVersion,
    handleExternalChange,
    openDocument,
    setDirty
  ])

  useEffect(() => {
    if (!command || command.version <= handledCommandVersionRef.current) {
      return
    }
    handledCommandVersionRef.current = command.version
    queueMicrotask(() => {
      if (command.type === 'save') {
        void saveCurrent(false)
      } else if (command.type === 'save-as') {
        void saveCurrent(true)
      } else if (command.type === 'reload') {
        void reload()
      } else {
        fitToContent()
      }
    })
  }, [command, fitToContent, reload, saveCurrent])

  useEffect(() => {
    onMetaChange(document.id, {
      path,
      status,
      dirty,
      feedbackCount: feedbackState.feedback.length,
      feedbackLoaded,
      feedbackActive: feedbackPanelOpen
    })
  }, [
    dirty,
    document.id,
    feedbackState.feedback.length,
    feedbackLoaded,
    feedbackPanelOpen,
    onMetaChange,
    path,
    status
  ])

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current)
      }
      const recording = recordingRef.current
      recordingStartRef.current = null
      if (recording) {
        if (recording.timeout) {
          clearTimeout(recording.timeout)
        }
        recording.processor.disconnect()
        recording.source.disconnect()
        recording.stream.getTracks().forEach((track) => track.stop())
        void recording.audioContext.close()
      }
      const jobId = dictationJobIdRef.current
      if (jobId) {
        void window.desktop.cancelDictation(jobId)
      }
    },
    []
  )

  const handleEditorChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles
    ): void => {
      if (applyingRef.current) {
        return
      }
      setOverlayViewport((current) =>
        current.scrollX === appState.scrollX &&
        current.scrollY === appState.scrollY &&
        current.zoom === appState.zoom.value
          ? current
          : {
              scrollX: appState.scrollX,
              scrollY: appState.scrollY,
              zoom: appState.zoom.value
            }
      )
      const nextElementBounds = Object.fromEntries(
        elements
          .filter((element) => !element.isDeleted)
          .map((element) => [
            element.id,
            {
              x: element.x,
              y: element.y,
              width: element.width,
              height: element.height
            }
          ])
      )
      setSceneElementBounds((current) =>
        boundsMapsEqual(current, nextElementBounds) ? current : nextElementBounds
      )
      if (dictationState === 'recording') {
        for (const id of Object.keys(appState.selectedElementIds)) {
          if (appState.selectedElementIds[id]) {
            recordingTargetIdsRef.current.add(id)
          }
        }
        const target = elementFeedbackTarget(
          elements,
          recordingTargetIdsRef.current
        )
        if (target) {
          setDraftTarget((current) =>
            sameElementFeedbackTarget(current, target) ? current : target
          )
        }
      }
      const scene = toScene(elements, appState, files)
      setCanvasBackground(appState.viewBackgroundColor)
      if (scenesEquivalent(currentSceneRef.current, scene)) {
        return
      }
      currentSceneRef.current = scene
      const nextDirty = !scenesEquivalent(baseSceneRef.current, scene)
      setDirty(nextDirty)
      if (nextDirty && !conflictRef.current) {
        setStatus('modified')
        setDetail(null)
        scheduleSave()
      }
    },
    [dictationState, scheduleSave, setDirty]
  )

  const changeCanvasBackground = useCallback((color: string): void => {
    const api = apiRef.current
    if (!api || !/^#[0-9a-f]{6}$/i.test(color)) {
      return
    }
    setCanvasBackground(color)
    api.updateScene({
      appState: {
        ...api.getAppState(),
        viewBackgroundColor: color
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    })
  }, [])

  useEffect(() => {
    let canceled = false
    void window.desktop
      .listFeedback(document.id)
      .then((nextState) => {
        if (!canceled) {
          setFeedbackState(nextState)
          setFeedbackLoaded(true)
        }
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setFeedbackError(messageFromError(error))
        }
      })
    return () => {
      canceled = true
    }
  }, [document.id])

  const startFreshDraft = useCallback((): void => {
    setDraftId(crypto.randomUUID())
    setDraftCreatedAt(new Date().toISOString())
    setDraftTarget({ type: 'drawing' })
    setDraftText('')
    draftTextRef.current = ''
    recordingTargetIdsRef.current.clear()
    interactionTraceRef.current = []
    setInteractionEventCount(0)
    setFeedbackError(null)
  }, [])

  const persistDraft = useCallback(
    async (
      snapshot?: FeedbackDraftSnapshot
    ): Promise<LocalFeedback | null> => {
    const text = (snapshot?.text ?? draftText).trim()
    if (text.length === 0) {
      setFeedbackError('Dictate or enter feedback before sending.')
      return null
    }
    const draft: LocalFeedback = {
      id: draftId,
      documentId: document.id,
      createdAt: draftCreatedAt,
      updatedAt: new Date().toISOString(),
      status: 'draft',
      text,
      target: snapshot?.target ?? draftTarget,
      interactionTrace:
        snapshot?.interactionTrace ?? interactionTraceRef.current
    }
    try {
      const saved = await window.desktop.upsertFeedback(draft)
      setFeedbackState((current) => ({
        ...current,
        feedback: [
          ...current.feedback.filter((item) => item.id !== saved.id),
          saved
        ]
      }))
      setFeedbackError(null)
      return saved
    } catch (error) {
      setFeedbackError(messageFromError(error))
      return null
    }
  },
    [document.id, draftCreatedAt, draftId, draftTarget, draftText]
  )

  const copyFeedback = useCallback(async (): Promise<void> => {
    const currentDraft = await persistDraft()
    if (!currentDraft) {
      return
    }
    try {
      const submission = await window.desktop.copyFeedbackSubmission({
        id: crypto.randomUUID(),
        documentId: document.id,
        feedbackIds: [currentDraft.id],
        documentRevision: fingerprintRef.current,
        createdAt: new Date().toISOString()
      })
      const nextState = await window.desktop.listFeedback(document.id)
      setFeedbackState(nextState)
      startFreshDraft()
      setFeedbackError(
        `Copied ${submission.feedback.length} feedback item${
          submission.feedback.length === 1 ? '' : 's'
        } to the clipboard.`
      )
    } catch (error) {
      setFeedbackError(messageFromError(error))
    }
  }, [
    document.id,
    persistDraft,
    startFreshDraft
  ])

  const pairAgent = useCallback(async (): Promise<void> => {
    if (!pairingCode.trim()) {
      setFeedbackError('Paste a one-time pairing code from the intended Copilot task.')
      return
    }
    setAgentBusy(true)
    try {
      const connection = await window.desktop.pairAgent({
        pairingCode: pairingCode.trim()
      })
      setAgentState((current) => ({ ...current, connection }))
      setPairingCode('')
      setFeedbackError('Paired with the selected Copilot task for this app session.')
    } catch (error) {
      setFeedbackError(messageFromError(error))
    } finally {
      setAgentBusy(false)
    }
  }, [pairingCode])

  const installCopilotCompanion = useCallback(async (): Promise<void> => {
    setCompanionBusy(true)
    try {
      const result = await window.desktop.installCopilotCompanion()
      setCompanionStatus(result.status)
      setFeedbackError(
        'Copilot companion installed. Restart GitHub Copilot or open a new task to activate it.'
      )
    } catch (error) {
      setFeedbackError(messageFromError(error))
    } finally {
      setCompanionBusy(false)
    }
  }, [])

  const unpairAgent = useCallback(async (): Promise<void> => {
    setAgentBusy(true)
    try {
      const connection = await window.desktop.unpairAgent()
      setAgentState((current) => ({ ...current, connection }))
      setFeedbackError('The Copilot task was unpaired. Pending local feedback was kept.')
    } catch (error) {
      setFeedbackError(messageFromError(error))
    } finally {
      setAgentBusy(false)
    }
  }, [])

  const deliverFeedback = useCallback(
    async (
      mode: AgentDeliveryMode,
      snapshot?: FeedbackDraftSnapshot
    ): Promise<boolean> => {
      const currentDraft = await persistDraft(snapshot)
      if (!currentDraft) {
        return false
      }
      setAgentBusy(true)
      try {
        const result = await window.desktop.deliverFeedback({
          id: crypto.randomUUID(),
          documentId: document.id,
          feedbackIds: [currentDraft.id],
          documentRevision: fingerprintRef.current,
          createdAt: new Date().toISOString(),
          mode
        })
        const [nextFeedback, nextAgent] = await Promise.all([
          window.desktop.listFeedback(document.id),
          window.desktop.listAgentActivity(document.id)
        ])
        setFeedbackState(nextFeedback)
        setAgentState(nextAgent)
        const accepted = result.attempt.status === 'accepted'
        if (accepted) {
          startFreshDraft()
        }
        setFeedbackError(
          accepted
            ? `${mode === 'immediate' ? 'Sent' : 'Queued'} feedback. Ready for another message.`
            : result.attempt.detail ?? 'The delivery result is unknown.'
        )
        return accepted
      } catch (error) {
        const refresh = await Promise.allSettled([
          window.desktop.listFeedback(document.id),
          window.desktop.listAgentActivity(document.id)
        ])
        if (refresh[0].status === 'fulfilled') {
          setFeedbackState(refresh[0].value)
        }
        if (refresh[1].status === 'fulfilled') {
          setAgentState(refresh[1].value)
        }
        setFeedbackError(messageFromError(error))
        return false
      } finally {
        setAgentBusy(false)
      }
    },
    [
      document.id,
      persistDraft,
      startFreshDraft
    ]
  )

  const retireAttempt = useCallback(
    async (attemptId: string): Promise<void> => {
      try {
        const retired = await window.desktop.retireAgentAttempt(attemptId)
        setAgentState((current) => ({
          ...current,
          attempts: current.attempts.map((attempt) =>
            attempt.id === retired.id
              ? { ...retired, documentId: document.id }
              : attempt
          )
        }))
        setFeedbackError('The unresolved attempt was retired without replay.')
      } catch (error) {
        setFeedbackError(messageFromError(error))
      }
    },
    [document.id]
  )

  const handlePointerUpdate = useCallback((update: PointerUpdate): void => {
    const startedAt = recordingStartedAtRef.current
    const api = apiRef.current
    if (!recordingRef.current || startedAt === null || !api) {
      return
    }

    const now = performance.now()
    const point = { x: update.pointer.x, y: update.pointer.y }
    const elementIds = elementIdsAtPoint(api.getSceneElements(), point)
    const isClick =
      update.button === 'down' && lastPointerButtonRef.current !== 'down'
    const previous = lastPointerSampleRef.current
    const distanceSquared = previous
      ? (point.x - previous.point.x) ** 2 +
        (point.y - previous.point.y) ** 2
      : Number.POSITIVE_INFINITY
    const shouldCapture =
      isClick ||
      !previous ||
      !sameIds(previous.elementIds, elementIds) ||
      now - previous.at >= 250 ||
      distanceSquared >= 24 ** 2

    lastPointerButtonRef.current = update.button
    if (!shouldCapture) {
      return
    }

    const interaction: FeedbackInteraction = {
      type: isClick ? 'click' : 'move',
      elapsedMs: Math.max(0, Math.round(now - startedAt)),
      point,
      elementIds
    }
    let nextTrace = interactionTraceRef.current
    if (nextTrace.length >= MAX_FEEDBACK_INTERACTION_EVENTS) {
      if (!isClick) {
        return
      }
      const firstMoveIndex = nextTrace.findIndex(
        (event) => event.type === 'move'
      )
      if (firstMoveIndex < 0) {
        return
      }
      nextTrace = nextTrace.filter((_, index) => index !== firstMoveIndex)
    }
    interactionTraceRef.current = [...nextTrace, interaction]
    lastPointerSampleRef.current = { at: now, point, elementIds }
    setInteractionEventCount(interactionTraceRef.current.length)

    if (isClick && elementIds.length > 0) {
      elementIds.forEach((id) => recordingTargetIdsRef.current.add(id))
      const target = elementFeedbackTarget(
        api.getSceneElements(),
        recordingTargetIdsRef.current
      )
      if (target) {
        setDraftTarget((current) =>
          sameElementFeedbackTarget(current, target) ? current : target
        )
      }
    }
  }, [])

  const finishRecording = useCallback(async (
    sendAfterTranscription = false
  ): Promise<void> => {
    const recording = recordingRef.current
    if (!recording) {
      return
    }
    recordingRef.current = null
    recordingStartedAtRef.current = null
    if (recording.timeout) {
      clearTimeout(recording.timeout)
    }
    recording.processor.disconnect()
    recording.source.disconnect()
    recording.stream.getTracks().forEach((track) => track.stop())
    await recording.audioContext.close()

    const length = recording.chunks.reduce(
      (total, chunk) => total + chunk.length,
      0
    )
    if (length === 0) {
      setDictationState('idle')
      setFeedbackError('No microphone audio was captured.')
      return
    }
    const samples = new Float32Array(length)
    let offset = 0
    for (const chunk of recording.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    setDictationState('transcribing')
    const jobId = crypto.randomUUID()
    dictationJobIdRef.current = jobId
    try {
      const downsampled = downsampleMonoPcmTo16Khz(
        samples,
        recording.sourceSampleRate
      )
      const wavData = new Uint8Array(encodePcm16Wav(downsampled))
      const result = await window.desktop.transcribe({
        jobId,
        documentId: document.id,
        draftId: recording.draftId,
        language: dictationLanguage,
        wavData
      })
      if (result.ok) {
        if (draftIdRef.current === recording.draftId) {
          const existingText = draftTextRef.current.trim()
          const text =
            existingText.length > 0
              ? `${existingText} ${result.text}`
              : result.text
          draftTextRef.current = text
          setDraftText(text)
          if (sendAfterTranscription) {
            if (!agentState.connection.paired) {
              setFeedbackError(
                'Transcript ready. Pair a Copilot task before sending.'
              )
            } else {
              const target =
                elementFeedbackTarget(
                  apiRef.current?.getSceneElements() ?? [],
                  recordingTargetIdsRef.current
                ) ?? { type: 'drawing' as const }
              await deliverFeedback('immediate', {
                text,
                target,
                interactionTrace: interactionTraceRef.current
              })
            }
          } else {
            setFeedbackError(null)
          }
        } else {
          setFeedbackError(
            'The draft changed before dictation finished, so the transcript was not inserted.'
          )
        }
      } else if (!result.canceled) {
        setFeedbackError(result.message)
      }
    } catch (error) {
      setFeedbackError(messageFromError(error))
    } finally {
      dictationJobIdRef.current = null
      setDictationState('idle')
    }
  }, [
    agentState.connection.paired,
    deliverFeedback,
    dictationLanguage,
    document.id
  ])

  const startRecording = useCallback(async (): Promise<void> => {
    if (
      recordingStartRef.current ||
      recordingRef.current ||
      dictationJobIdRef.current
    ) {
      return
    }
    recordingTargetIdsRef.current.clear()
    interactionTraceRef.current = []
    recordingStartedAtRef.current = null
    lastPointerButtonRef.current = 'up'
    lastPointerSampleRef.current = null
    setInteractionEventCount(0)
    setDraftTarget({ type: 'drawing' })
    const startToken = {}
    recordingStartRef.current = startToken
    setDictationState('starting')
    let stream: MediaStream | undefined
    let audioContext: AudioContext | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      })
      if (recordingStartRef.current !== startToken) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      await audioContext.audioWorklet.addModule(
        new URL('audio-capture-worklet.js', window.location.href).href
      )
      if (recordingStartRef.current !== startToken) {
        source.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        await audioContext.close()
        return
      }
      const processor = new AudioWorkletNode(audioContext, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
      const chunks: Float32Array[] = []
      processor.port.onmessage = (messageEvent: MessageEvent<ArrayBuffer>) => {
        chunks.push(new Float32Array(messageEvent.data))
      }
      source.connect(processor)
      processor.connect(audioContext.destination)
      const recording: RecordingSession = {
        audioContext,
        processor,
        source,
        stream,
        chunks,
        sourceSampleRate: audioContext.sampleRate,
        draftId
      }
      recording.timeout = setTimeout(() => {
        if (recordingRef.current === recording) {
          void finishRecording()
        }
      }, MAX_AUDIO_DURATION_SECONDS * 1000)
      recordingRef.current = recording
      recordingStartedAtRef.current = performance.now()
      setDictationState('recording')
      setFeedbackError(null)
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close()
      }
      if (recordingStartRef.current === startToken) {
        setFeedbackError(`Microphone access failed: ${messageFromError(error)}`)
      }
    } finally {
      if (recordingStartRef.current === startToken) {
        recordingStartRef.current = null
        if (!recordingRef.current) {
          setDictationState('idle')
        }
      }
    }
  }, [draftId, finishRecording])

  const cancelDictation = useCallback(async (): Promise<void> => {
    if (recordingRef.current) {
      const recording = recordingRef.current
      recordingRef.current = null
      if (recording.timeout) {
        clearTimeout(recording.timeout)
      }
      recording.processor.disconnect()
      recording.source.disconnect()
      recording.stream.getTracks().forEach((track) => track.stop())
      await recording.audioContext.close()
      recordingStartedAtRef.current = null
      setDictationState('idle')
      return
    }
    if (dictationJobIdRef.current) {
      await window.desktop.cancelDictation(dictationJobIdRef.current)
    }
  }, [])

  const toOverlayBounds = useCallback(
    (bounds: FeedbackBounds): React.CSSProperties => {
      return {
        left: (bounds.x + overlayViewport.scrollX) * overlayViewport.zoom,
        top: (bounds.y + overlayViewport.scrollY) * overlayViewport.zoom,
        width: Math.max(4, bounds.width * overlayViewport.zoom),
        height: Math.max(4, bounds.height * overlayViewport.zoom)
      }
    },
    [overlayViewport]
  )

  const currentElementTargetBounds = useCallback(
    (target: Extract<FeedbackTarget, { type: 'elements' }>): FeedbackBounds => {
      const current = target.elementIds.flatMap((id) => {
        const bounds = sceneElementBounds[id]
        return bounds ? [bounds] : []
      })
      if (current.length === 0) {
        return target.originalBounds
      }
      const minX = Math.min(...current.map((bounds) => bounds.x))
      const minY = Math.min(...current.map((bounds) => bounds.y))
      const maxX = Math.max(
        ...current.map((bounds) => bounds.x + bounds.width)
      )
      const maxY = Math.max(
        ...current.map((bounds) => bounds.y + bounds.height)
      )
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      }
    },
    [sceneElementBounds]
  )

  const keepLocal = useCallback((): void => {
    const pending = conflictRef.current
    if (!pending) {
      return
    }
    baseSceneRef.current = pending.external
    fingerprintRef.current = pending.externalFingerprint
    currentSceneRef.current = pending.local
    conflictRef.current = null
    setConflict(null)
    setDirty(true)
    void saveCurrent(false)
  }, [saveCurrent, setDirty])

  const loadExternal = useCallback((): void => {
    const pending = conflictRef.current
    if (!pending) {
      return
    }
    baseSceneRef.current = pending.external
    fingerprintRef.current = pending.externalFingerprint
    currentSceneRef.current = pending.external
    conflictRef.current = null
    setConflict(null)
    setDetail(null)
    setDirty(false)
    applyToEditor(pending.external, pending.local)
    setTemporaryStatus('external-applied')
  }, [applyToEditor, setDirty, setTemporaryStatus])

  const saveLocalCopy = useCallback(async (): Promise<void> => {
    const pending = conflictRef.current
    if (!pending) {
      return
    }
    currentSceneRef.current = pending.local
    if (await saveCurrent(true)) {
      loadExternal()
    }
  }, [loadExternal, saveCurrent])

  const initialData = editorSeed.scene as unknown as ExcalidrawInitialDataState
  const conflictSummary = conflict
    ? `${conflict.details.elementIds.length} element conflict${
        conflict.details.elementIds.length === 1 ? '' : 's'
      }${
        conflict.details.fileIds.length > 0
          ? ` and ${conflict.details.fileIds.length} embedded file conflict${
              conflict.details.fileIds.length === 1 ? '' : 's'
            }`
          : ''
      }`
    : ''
  const latestAgentAttempt = agentState.attempts[0]

  return (
    <section
      className={`document-pane${active ? ' document-pane--active' : ''}${
        feedbackPanelOpen ? ' document-pane--feedback-active' : ''
      }`}
      aria-hidden={!active}
    >
      <div className="document-toolbar">
        <div className="document-identity">
          <strong>{documentName(path)}</strong>
          <span title={path ?? undefined}>{path ?? 'Unsaved drawing'}</span>
        </div>
        <div className="header-actions">
          <span className={`status status--${status}`} aria-live="polite">
            {statusLabels[status]}
          </span>
          <button
            type="button"
            aria-pressed={feedbackPanelOpen}
            onClick={() => setFeedbackPanelOpen((open) => !open)}
          >
            Give feedback
          </button>
          <label className="color-control" title="Choose the canvas background color">
            <span>Canvas</span>
            <input
              type="color"
              aria-label="Canvas background color"
              value={canvasBackground}
              onChange={(changeEvent) =>
                changeCanvasBackground(changeEvent.target.value)
              }
            />
          </label>
          <button type="button" onClick={fitToContent}>
            Fit to Content
          </button>
          <button
            type="button"
            disabled={!path}
            onClick={() => void reload()}
          >
            Reload
          </button>
        </div>
      </div>

      {detail && (
        <div className={`banner banner--${status}`} role="alert">
          <span>{detail}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => setDetail(null)}
          >
            ×
          </button>
        </div>
      )}

      <div className="canvas-shell">
        <Excalidraw
          key={editorSeed.key}
          initialData={initialData}
          excalidrawAPI={(api) => {
            apiRef.current = api
          }}
          onChange={handleEditorChange}
          onPointerUpdate={handlePointerUpdate}
          theme={theme}
          autoFocus={focused}
          handleKeyboardGlobally={focused}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: true,
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: true
            }
          }}
        />
        <div
          className="feedback-overlay"
          aria-hidden="true"
        >
          {feedbackPanelOpen &&
            draftTarget &&
            (draftTarget.type === 'drawing' ? (
              <div className="feedback-anchor feedback-anchor--drawing">
                <span>1</span>
              </div>
            ) : (
              <div
                className={`feedback-anchor feedback-anchor--${draftTarget.type}`}
                style={toOverlayBounds(
                  draftTarget.type === 'elements'
                    ? currentElementTargetBounds(draftTarget)
                    : draftTarget.type === 'region'
                      ? draftTarget.region
                      : {
                          ...draftTarget.point,
                          width: 0,
                          height: 0
                        }
                )}
              >
                <span>1</span>
              </div>
            ))}
        </div>
        {feedbackPanelOpen && (
          <aside
            className={`feedback-panel${
              dictationState !== 'idle'
                ? ' feedback-panel--capturing'
                : ''
            }`}
            aria-label="Drawing feedback"
          >
            <header>
              <div>
                <span className="dialog-kicker">Copilot collaboration</span>
                <h2>
                  {dictationState === 'recording'
                    ? 'Recording feedback'
                    : dictationState === 'transcribing'
                      ? 'Transcribing feedback'
                      : 'Give feedback'}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close feedback panel"
                disabled={dictationState !== 'idle'}
                onClick={() => setFeedbackPanelOpen(false)}
              >
                ×
              </button>
            </header>

            <section className="agent-connection">
              <div className="feedback-list-heading">
                <span className="feedback-section-label">Copilot task</span>
                <span
                  className={`agent-readiness agent-readiness--${agentState.connection.readiness}`}
                >
                  {agentState.connection.paired
                    ? agentState.connection.readiness
                    : 'not paired'}
                </span>
              </div>
              {agentState.connection.paired ? (
                <>
                  {agentState.connection.blockedReason && (
                    <p className="feedback-message">
                      Waiting in Copilot: {agentState.connection.blockedReason}
                    </p>
                  )}
                  {agentState.connection.detail && (
                    <p className="feedback-message">
                      {agentState.connection.detail}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {companionStatus?.state === 'current' && (
                    <p className="companion-install-status">
                      Companion installed for all repositories. Open a new Copilot
                      task after an update.
                    </p>
                  )}
                  {companionStatus?.state === 'unmanaged' && (
                    <p className="feedback-message">
                      A companion with the same name already exists in your user
                      extensions and is not managed by Visualizer.
                    </p>
                  )}
                  {(companionStatus?.state === 'not-installed' ||
                    companionStatus?.state === 'update-available') && (
                    <div className="companion-install">
                      <p>
                        {companionStatus.state === 'not-installed'
                          ? 'Install the bundled companion once to make it available in every repository.'
                          : 'A newer bundled companion is available.'}
                      </p>
                      <button
                        type="button"
                        disabled={companionBusy}
                        onClick={() => void installCopilotCompanion()}
                      >
                        {companionBusy
                          ? 'Installing…'
                          : companionStatus.state === 'not-installed'
                            ? 'Install Copilot companion'
                            : 'Update Copilot companion'}
                      </button>
                    </div>
                  )}
                  <p>
                    Open the Visualizer companion in the intended Copilot task,
                    copy its one-time code, and paste it below.
                  </p>
                  <textarea
                    value={pairingCode}
                    rows={3}
                    maxLength={4096}
                    disabled={agentBusy}
                    placeholder="evp1:…"
                    aria-label="One-time Copilot pairing code"
                    onChange={(event) => setPairingCode(event.target.value)}
                  />
                  <button
                    type="button"
                    className="primary-button"
                    disabled={agentBusy || !pairingCode.trim()}
                    onClick={() => void pairAgent()}
                  >
                    Pair this task
                  </button>
                </>
              )}
            </section>

            <section className="feedback-composer">
              <div className="feedback-auto-context">
                <div>
                  <span className="feedback-section-label">
                    Automatic context
                  </span>
                  <strong>{targetLabel(draftTarget)}</strong>
                </div>
                <span>
                  {interactionEventCount} interaction
                  {interactionEventCount === 1 ? '' : 's'}
                </span>
              </div>

              <label className="feedback-text-label">
                <span className="feedback-section-heading">
                  <span>Feedback</span>
                  <span className="feedback-character-count">
                    {draftText.length.toLocaleString()} / 10,000
                  </span>
                </span>
                <textarea
                  value={draftText}
                  maxLength={10_000}
                  rows={5}
                  disabled={dictationState !== 'idle'}
                  placeholder="Describe the requested change or question."
                  onChange={(changeEvent) => {
                    draftTextRef.current = changeEvent.target.value
                    setDraftText(changeEvent.target.value)
                  }}
                />
              </label>

              <div className="dictation-controls">
                <select
                  aria-label="Dictation language"
                  value={dictationLanguage}
                  disabled={dictationState !== 'idle'}
                  onChange={(changeEvent) =>
                    setDictationLanguage(
                      changeEvent.target.value as DictationLanguage
                    )
                  }
                >
                  <option value="auto">Auto language</option>
                  <option value="sv">Svenska</option>
                  <option value="en">English</option>
                </select>
                {dictationState === 'idle' ? (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void startRecording()}
                  >
                    Start dictating
                  </button>
                ) : dictationState === 'starting' ? (
                  <button type="button" disabled>
                    Starting microphone…
                  </button>
                ) : (
                  <button type="button" onClick={() => void cancelDictation()}>
                    {dictationState === 'recording'
                      ? 'Stop without transcript'
                      : 'Cancel transcription'}
                  </button>
                )}
                {dictationState === 'recording' && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={agentBusy}
                    onClick={() =>
                      void finishRecording(agentState.connection.paired)
                    }
                  >
                    {agentState.connection.paired
                      ? 'Send feedback'
                      : 'Finish dictation'}
                  </button>
                )}
              </div>
              {dictationState !== 'idle' && (
                <p className="feedback-progress" role="status">
                  {dictationState === 'starting'
                    ? 'Requesting microphone access…'
                    : dictationState === 'recording'
                      ? 'Recording movement, hovered elements, and clicks.'
                      : agentState.connection.paired
                        ? 'Transcribing locally, then sending…'
                        : 'Transcribing locally…'}
                </p>
              )}
              {feedbackError && (
                <p className="feedback-message" role="status">
                  {feedbackError}
                </p>
              )}
              <div className="feedback-composer-actions">
                <div className="feedback-draft-actions">
                  <button
                    type="button"
                    disabled={dictationState !== 'idle'}
                    onClick={startFreshDraft}
                  >
                    Clear
                  </button>
                </div>
                <div className="feedback-delivery-actions">
                  <button
                    type="button"
                    className={
                      agentState.connection.paired ? undefined : 'primary-button'
                    }
                    disabled={dictationState !== 'idle' || agentBusy}
                    onClick={() => void copyFeedback()}
                  >
                    Copy for agent
                  </button>
                  <button
                    type="button"
                    title="Queue for paired task"
                    disabled={
                      dictationState !== 'idle' ||
                      agentBusy ||
                      !agentState.connection.paired
                    }
                    onClick={() => void deliverFeedback('enqueue')}
                  >
                    Queue
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    title="Steer the paired task immediately with a narrowly scoped change"
                    disabled={
                      dictationState !== 'idle' ||
                      agentBusy ||
                      !agentState.connection.paired
                    }
                    onClick={() => void deliverFeedback('immediate')}
                  >
                    Send now
                  </button>
                </div>
              </div>
            </section>

            <footer className="feedback-panel-footer">
              {latestAgentAttempt && (
                <div className="feedback-latest-delivery">
                  <span>
                    {latestAgentAttempt.mode === 'immediate'
                      ? 'Sent now'
                      : 'Queued'}
                  </span>
                  <strong>
                    {latestAgentAttempt.status.replaceAll('-', ' ')}
                  </strong>
                  {(latestAgentAttempt.status === 'unknown' ||
                    latestAgentAttempt.status === 'prepared') && (
                    <button
                      type="button"
                      onClick={() =>
                        void retireAttempt(latestAgentAttempt.id)
                      }
                    >
                      Retire without replay
                    </button>
                  )}
                </div>
              )}
              {agentState.connection.paired && (
                <button
                  type="button"
                  className="agent-unpair-button"
                  disabled={agentBusy}
                  onClick={() => void unpairAgent()}
                >
                  Unpair
                </button>
              )}
            </footer>
          </aside>
        )}
      </div>

      {conflict && (
        <div className="modal-backdrop" role="presentation">
          <section className="conflict-dialog" role="dialog" aria-modal="true">
            <span className="dialog-kicker">Concurrent edit detected</span>
            <h2>Choose how to resolve this conflict</h2>
            <p>
              Local and external changes overlap: <strong>{conflictSummary}</strong>.
            </p>
            {conflict.details.elementIds.length > 0 && (
              <code title={conflict.details.elementIds.join(', ')}>
                {conflict.details.elementIds.slice(0, 6).join(', ')}
                {conflict.details.elementIds.length > 6 ? '…' : ''}
              </code>
            )}
            <div className="dialog-actions">
              <button type="button" className="primary-button" onClick={keepLocal}>
                Keep local version
              </button>
              <button type="button" onClick={loadExternal}>
                Load external version
              </button>
              <button type="button" onClick={() => void saveLocalCopy()}>
                Save local as a separate file
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

export function App(): React.JSX.Element {
  const eventVersionRef = useRef(0)
  const commandVersionRef = useRef(0)
  const metaRef = useRef(new Map<string, EditorMeta>())
  const [tabs, setTabs] = useState<TabEntry[]>([])
  const tabsRef = useRef<TabEntry[]>([])
  const [editorMeta, setEditorMeta] = useState<Record<string, EditorMeta>>({})
  const [activeDocuments, setActiveDocuments] = useState<
    Partial<Record<PaneId, string>>
  >({})
  const [focusedPane, setFocusedPane] = useState<PaneId>('primary')
  const [commands, setCommands] = useState<Record<string, EditorCommand>>({})
  const [detail, setDetail] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle')
  const [updateProgress, setUpdateProgress] = useState(0)
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(
    null
  )
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [systemTheme, setSystemTheme] = useState<Theme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference)
  const theme = themePreference === 'system' ? systemTheme : themePreference
  const activeDocumentId =
    activeDocuments[focusedPane] ??
    activeDocuments.primary ??
    activeDocuments.secondary ??
    null
  const feedbackActive =
    activeDocumentId !== null &&
    editorMeta[activeDocumentId]?.feedbackActive === true
  const split = tabs.some((tab) => tab.pane === 'secondary')

  const selectDocument = useCallback(
    (documentId: string | null, pane: PaneId = 'primary'): void => {
      setFocusedPane(pane)
      setActiveDocuments((current) => ({
        ...current,
        [pane]: documentId ?? undefined
      }))
    },
    []
  )

  const activateDocument = useCallback(
    (documentId: string | null, pane: PaneId = 'primary'): void => {
      selectDocument(documentId, pane)
      window.desktop.setActiveDocument(documentId)
    },
    [selectDocument]
  )

  const handleDocumentEvent = useCallback(
    (event: DocumentEvent): void => {
      if (event.type === 'activate') {
        const pane =
          tabsRef.current.find((tab) => tab.document.id === event.documentId)
            ?.pane ??
          focusedPane
        selectDocument(event.documentId, pane)
        return
      }

      const documentId =
        event.type === 'opened' ? event.document.id : event.documentId
      const version = ++eventVersionRef.current
      const pane =
        tabsRef.current.find((tab) => tab.document.id === documentId)?.pane ??
        focusedPane
      setTabs((current) => {
        const existing = current.find((tab) => tab.document.id === documentId)
        let next: TabEntry[]
        if (event.type === 'opened') {
          const nextTab: TabEntry = {
            document: event.document,
            event,
            eventVersion: version,
            pane: existing?.pane ?? pane
          }
          next = existing
            ? current.map((tab) =>
                tab.document.id === documentId ? nextTab : tab
              )
            : [...current, nextTab]
        } else {
          next = current.map((tab) =>
            tab.document.id === documentId
              ? { ...tab, event, eventVersion: version }
              : tab
          )
        }
        tabsRef.current = next
        return next
      })
      if (event.type === 'opened') {
        activateDocument(documentId, pane)
      }
    },
    [activateDocument, focusedPane, selectDocument]
  )

  const openPath = useCallback(async (requestedPath: string): Promise<void> => {
    setDetail(null)
    try {
      await window.desktop.openPath(requestedPath)
    } catch (error) {
      setDetail(messageFromError(error))
    }
  }, [])

  const openDialog = useCallback(async (): Promise<void> => {
    setDetail(null)
    try {
      await window.desktop.openDialog()
    } catch (error) {
      setDetail(messageFromError(error))
    }
  }, [])

  const newDocument = useCallback(async (): Promise<void> => {
    setDetail(null)
    try {
      await window.desktop.newDocument()
    } catch (error) {
      setDetail(messageFromError(error))
    }
  }, [])

  const sendEditorCommand = useCallback(
    (
      documentId: string | null,
      type: EditorCommand['type']
    ): void => {
      if (!documentId) {
        return
      }
      const command = { version: ++commandVersionRef.current, type }
      setCommands((current) => ({ ...current, [documentId]: command }))
      activateDocument(
        documentId,
        tabs.find((tab) => tab.document.id === documentId)?.pane ?? focusedPane
      )
    },
    [activateDocument, focusedPane, tabs]
  )

  const handleCommand = useCallback(
    (command: AppCommand): void => {
      if (command.type === 'new') {
        void newDocument()
      } else if (command.type === 'open') {
        void openDialog()
      } else if (command.type === 'open-path') {
        void openPath(command.path)
      } else {
        sendEditorCommand(command.documentId, command.type)
      }
    },
    [newDocument, openDialog, openPath, sendEditorCommand]
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onThemeChange = (event: MediaQueryListEvent): void =>
      setSystemTheme(event.matches ? 'dark' : 'light')
    media.addEventListener('change', onThemeChange)
    return () => media.removeEventListener('change', onThemeChange)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(themePreferenceStorageKey, themePreference)
  }, [themePreference])

  useEffect(() => {
    let canceled = false
    void window.desktop
      .getAppVersion()
      .then((version) => {
        if (!canceled) {
          setAppVersion(version)
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDetail(`Could not read the application version: ${messageFromError(error)}`)
        }
      })
    const removeProgressListener = window.desktop.onUpdateProgress((progress) => {
      setUpdateProgress(Math.max(0, Math.min(1, progress)))
    })
    return () => {
      canceled = true
      removeProgressListener()
    }
  }, [])

  useEffect(() => {
    const removeDocumentListener = window.desktop.onDocumentEvent(handleDocumentEvent)
    const removeCommandListener = window.desktop.onAppCommand(handleCommand)
    void window.desktop.rendererReady().then((launchPaths) => {
      for (const launchPath of launchPaths) {
        void openPath(launchPath)
      }
    })
    return () => {
      removeDocumentListener()
      removeCommandListener()
    }
  }, [handleCommand, handleDocumentEvent, openPath])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const dismiss = (): void => setContextMenu(null)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [contextMenu])

  const checkForUpdates = useCallback(async (): Promise<void> => {
    setUpdatePhase('checking')
    setDetail(null)
    try {
      const result = await window.desktop.checkForUpdates()
      setUpdateResult(result)
      if (!result.checked) {
        setUpdatePhase('error')
        setDetail(result.reason ?? 'The update check failed.')
      } else if (!result.available) {
        setUpdatePhase('current')
      } else if (!result.installable || !result.asset) {
        setUpdatePhase('error')
        setDetail(result.reason ?? 'This update cannot be installed automatically.')
      } else {
        setUpdatePhase('available')
        setDetail(
          `Version ${result.latestVersion} is available. Click Install update to download and install it.`
        )
      }
    } catch (error) {
      setUpdatePhase('error')
      setDetail(messageFromError(error))
    }
  }, [])

  const installUpdate = useCallback(async (): Promise<void> => {
    if (!updateResult?.asset) {
      return
    }
    setUpdatePhase('downloading')
    setUpdateProgress(0)
    setDetail(null)
    try {
      const result = await window.desktop.installUpdate(updateResult.asset)
      if (result.installed) {
        setUpdatePhase('installing')
        return
      }
      setUpdatePhase('idle')
      setUpdateResult(null)
      setDetail(result.message ?? 'The downloaded update was opened.')
    } catch (error) {
      setUpdatePhase('available')
      setDetail(messageFromError(error))
    }
  }, [updateResult])

  const updateButtonLabel =
    updatePhase === 'checking'
      ? 'Checking…'
      : updatePhase === 'current'
        ? 'No update available'
        : updatePhase === 'available'
          ? `Install ${updateResult?.latestVersion ?? 'update'}`
          : updatePhase === 'downloading'
            ? `Downloading ${Math.round(updateProgress * 100)}%`
            : updatePhase === 'installing'
              ? 'Installing…'
              : updatePhase === 'error'
                ? 'Check again'
                : 'Check for updates'

  const handleUpdateAction = (): void => {
    if (updatePhase === 'available') {
      void installUpdate()
    } else {
      void checkForUpdates()
    }
  }

  const updateMeta = useCallback((documentId: string, meta: EditorMeta): void => {
    metaRef.current.set(documentId, meta)
    setEditorMeta((current) =>
      current[documentId] === meta
        ? current
        : { ...current, [documentId]: meta }
    )
  }, [])

  const closeTab = useCallback(
    async (documentId: string): Promise<void> => {
      const closingTab = tabs.find((tab) => tab.document.id === documentId)
      if (!closingTab) {
        return
      }
      const meta = metaRef.current.get(documentId)
      if (!meta?.path && !meta?.feedbackLoaded) {
        setDetail('Wait for local feedback to finish loading before closing this tab.')
        return
      }
      if (!meta?.path && (meta?.feedbackCount ?? 0) > 0) {
        setDetail(
          'Save this untitled drawing before closing it so its local feedback can be recovered later.'
        )
        return
      }
      if (
        meta?.dirty &&
        !window.confirm('Close this tab and discard its unsaved changes?')
      ) {
        return
      }
      await window.desktop.closeDocument(documentId)
      metaRef.current.delete(documentId)
      setEditorMeta((current) => {
        const next = { ...current }
        delete next[documentId]
        return next
      })
      const index = tabs.findIndex((tab) => tab.document.id === documentId)
      let next = tabs.filter((tab) => tab.document.id !== documentId)
      if (
        closingTab.pane === 'primary' &&
        !next.some((tab) => tab.pane === 'primary') &&
        next.some((tab) => tab.pane === 'secondary')
      ) {
        next = next.map((tab) => ({ ...tab, pane: 'primary' }))
      }
      tabsRef.current = next
      setTabs(next)
      const nextInPane =
        next.find(
          (tab, candidateIndex) =>
            tab.pane === closingTab.pane && candidateIndex >= index
        ) ??
        [...next].reverse().find((tab) => tab.pane === closingTab.pane) ??
        next[0]
      setActiveDocuments((current) => {
        const updated = { ...current }
        if (current[closingTab.pane] === documentId) {
          if (nextInPane) {
            updated[closingTab.pane] = nextInPane.document.id
          } else {
            delete updated[closingTab.pane]
          }
        }
        if (!next.some((tab) => tab.pane === 'secondary')) {
          delete updated.secondary
        }
        return updated
      })
      if (activeDocumentId === documentId) {
        queueMicrotask(() =>
          activateDocument(
            nextInPane?.document.id ?? null,
            nextInPane?.pane ?? 'primary'
          )
        )
      }
    },
    [activateDocument, activeDocumentId, tabs]
  )

  const moveTab = useCallback(
    (documentId: string, pane: PaneId): void => {
      const moving = tabs.find((tab) => tab.document.id === documentId)
      if (!moving) {
        return
      }
      const targetPane =
        pane === 'secondary' &&
        moving.pane === 'primary' &&
        tabs.filter((tab) => tab.pane === 'primary').length === 1
          ? 'primary'
          : pane
      const next = tabs.map((tab) =>
        tab.document.id === documentId
          ? { ...tab, pane: targetPane }
          : tab
      )
      tabsRef.current = next
      setTabs(next)
      setFocusedPane(targetPane)
      setActiveDocuments((current) => {
        const updated = { ...current, [targetPane]: documentId }
        if (
          moving.pane !== targetPane &&
          current[moving.pane] === documentId
        ) {
          const replacement = tabs.find(
            (tab) =>
              tab.document.id !== documentId && tab.pane === moving.pane
          )
          if (replacement) {
            updated[moving.pane] = replacement.document.id
          } else {
            delete updated[moving.pane]
          }
        }
        return updated
      })
      window.desktop.setActiveDocument(documentId)
      setDraggingDocumentId(null)
    },
    [tabs]
  )

  const detachTab = useCallback(
    async (documentId: string): Promise<void> => {
      const meta = metaRef.current.get(documentId)
      if (!meta?.path) {
        setDetail('Save this drawing before moving it to another window.')
        return
      }
      if (meta.dirty) {
        setDetail('Save all changes before moving this drawing to another window.')
        return
      }
      try {
        await window.desktop.openInNewWindow(documentId)
        await closeTab(documentId)
      } catch (error) {
        setDetail(messageFromError(error))
      }
    },
    [closeTab]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault()
      for (const file of event.dataTransfer.files) {
        const droppedPath = window.desktop.getDroppedFilePath(file)
        if (!droppedPath.toLowerCase().endsWith('.excalidraw')) {
          setDetail('Only .excalidraw files can be opened')
          continue
        }
        void openPath(droppedPath)
      }
    },
    [openPath]
  )

  return (
    <div
      className={`app app--${theme}${
        feedbackActive ? ' app--feedback-active' : ''
      }`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="document-identity">
          <strong>Excalidraw Visualizer</strong>
          {appVersion && (
            <span className="app-version" title={`Version ${appVersion}`}>
              {appVersion}
            </span>
          )}
          <span>Local diagrams and visual feedback</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="update-button"
            disabled={
              updatePhase === 'checking' ||
              updatePhase === 'downloading' ||
              updatePhase === 'installing'
            }
            onClick={handleUpdateAction}
          >
            {updateButtonLabel}
          </button>
          <label className="theme-control">
            <span>Theme</span>
            <select
              aria-label="Application theme"
              value={themePreference}
              onChange={(event) =>
                setThemePreference(event.target.value as ThemePreference)
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <button type="button" onClick={() => void newDocument()}>
            New
          </button>
          <button type="button" onClick={() => void openDialog()}>
            Open
          </button>
        </div>
      </header>

      <div className={`document-tabs${split ? ' document-tabs--split' : ''}`}>
        {(['primary', 'secondary'] as const)
          .filter((pane) => pane === 'primary' || split)
          .map((pane) => (
            <nav
              key={pane}
              className={`document-tab-strip document-tab-strip--${pane}`}
              aria-label={`${pane === 'primary' ? 'Primary' : 'Secondary'} drawings`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (draggingDocumentId) {
                  moveTab(draggingDocumentId, pane)
                }
              }}
            >
              {tabs
                .filter((tab) => tab.pane === pane)
                .map((tab) => {
                  const meta = editorMeta[tab.document.id]
                  const tabPath = meta?.path ?? tab.document.path
                  return (
                    <div
                      key={tab.document.id}
                      className={`document-tab${
                        tab.document.id === activeDocuments[pane]
                          ? ' document-tab--active'
                          : ''
                      }`}
                      draggable
                      onDragStart={() =>
                        setDraggingDocumentId(tab.document.id)
                      }
                      onDragEnd={() => setDraggingDocumentId(null)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        activateDocument(tab.document.id, pane)
                        setContextMenu({
                          documentId: tab.document.id,
                          x: event.clientX,
                          y: event.clientY
                        })
                      }}
                    >
                      <button
                        type="button"
                        className="document-tab__select"
                        title={tabPath ?? 'Untitled drawing'}
                        onClick={() => activateDocument(tab.document.id, pane)}
                      >
                        <span>{documentName(tabPath)}</span>
                        {meta?.dirty && (
                          <span aria-label="Unsaved changes">●</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="document-tab__close"
                        aria-label={`Close ${documentName(tabPath)}`}
                        onClick={() => void closeTab(tab.document.id)}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
            </nav>
          ))}
      </div>

      {detail && (
        <div className="global-banner" role="alert">
          <span>{detail}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setDetail(null)}>
            ×
          </button>
        </div>
      )}

      <main className={`workspace${split ? ' workspace--split' : ''}`}>
        {tabs.length === 0 ? (
          <section className="welcome">
            <div className="welcome-card">
              <div className="welcome-mark" aria-hidden="true">
                EV
              </div>
              <h1>Open or create a drawing</h1>
              <p>
                Work across several local diagrams while each file keeps its own
                watcher, autosave state, viewport, and conflict handling.
              </p>
              <div className="welcome-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void openDialog()}
                >
                  Open .excalidraw files
                </button>
                <button type="button" onClick={() => void newDocument()}>
                  New drawing
                </button>
              </div>
              <small>You can also drop one or more files anywhere in this window.</small>
            </div>
          </section>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.document.id}
              className={`editor-slot editor-slot--${tab.pane}${
                activeDocuments[tab.pane] === tab.document.id
                  ? ' editor-slot--active'
                  : ''
              }`}
            >
              <DocumentEditor
                document={tab.document}
                event={tab.event}
                eventVersion={tab.eventVersion}
                command={commands[tab.document.id] ?? null}
                active={activeDocuments[tab.pane] === tab.document.id}
                focused={
                  focusedPane === tab.pane &&
                  activeDocuments[tab.pane] === tab.document.id
                }
                theme={theme}
                onMetaChange={updateMeta}
              />
            </div>
          ))
        )}
        {draggingDocumentId && !split && tabs.length > 1 && (
          <div
            className="split-drop-target"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              moveTab(draggingDocumentId, 'secondary')
            }}
          >
            Drop for side-by-side view
          </div>
        )}
      </main>

      {contextMenu && (
        <div
          className="tab-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {tabs.length > 1 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const tab = tabs.find(
                  (candidate) =>
                    candidate.document.id === contextMenu.documentId
                )
                if (tab) {
                  moveTab(
                    tab.document.id,
                    tab.pane === 'primary' ? 'secondary' : 'primary'
                  )
                }
                setContextMenu(null)
              }}
            >
              {tabs.find(
                (tab) => tab.document.id === contextMenu.documentId
              )?.pane === 'secondary'
                ? 'Move to primary view'
                : 'Move to side view'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void detachTab(contextMenu.documentId)
              setContextMenu(null)
            }}
          >
            Move to new window
          </button>
        </div>
      )}
    </div>
  )
}
