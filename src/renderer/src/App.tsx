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
  DocumentEvent,
  DocumentStatus,
  OpenedDocument
} from '../../shared/contracts'
import type { DictationLanguage } from '../../shared/contracts'
import type {
  FeedbackBounds,
  FeedbackDocumentState,
  FeedbackTarget,
  LocalFeedback
} from '../../shared/feedback'

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

type TabEntry = {
  document: OpenedDocument
  event: DocumentEvent | null
  eventVersion: number
}

type EditorMeta = {
  path: string | null
  status: DocumentStatus
  dirty: boolean
  feedbackCount: number
  feedbackLoaded: boolean
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
  theme: Theme
  onMetaChange: (documentId: string, meta: EditorMeta) => void
}

type CaptureMode = 'point' | 'region' | null

type RecordingSession = {
  audioContext: AudioContext
  processor: AudioWorkletNode
  source: MediaStreamAudioSourceNode
  stream: MediaStream
  chunks: Float32Array[]
  sourceSampleRate: number
  draftId: string
  target: FeedbackTarget
  timeout?: ReturnType<typeof setTimeout>
}

const themePreferenceStorageKey = 'excalidraw-visualizer-theme'
const defaultCanvasBackground = '#ffffff'

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

function DocumentEditor({
  document,
  event,
  eventVersion,
  command,
  active,
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
  const canvasShellRef = useRef<HTMLDivElement | null>(null)
  const recordingRef = useRef<RecordingSession | null>(null)
  const recordingStartRef = useRef<object | null>(null)
  const dictationJobIdRef = useRef<string | null>(null)
  const regionStartRef = useRef<{ x: number; y: number } | null>(null)

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
  const [feedbackPanelOpen, setFeedbackPanelOpen] = useState(false)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID())
  const [draftCreatedAt, setDraftCreatedAt] = useState(() =>
    new Date().toISOString()
  )
  const [draftTarget, setDraftTarget] = useState<FeedbackTarget | null>(null)
  const [draftText, setDraftText] = useState('')
  const draftIdRef = useRef(draftId)
  const [captureMode, setCaptureMode] = useState<CaptureMode>(null)
  const [regionPreview, setRegionPreview] = useState<FeedbackBounds | null>(null)
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
      feedbackLoaded
    })
  }, [
    dirty,
    document.id,
    feedbackState.feedback.length,
    feedbackLoaded,
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
    [scheduleSave, setDirty]
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
    setDraftTarget(null)
    setDraftText('')
    setCaptureMode(null)
    setRegionPreview(null)
    setFeedbackError(null)
  }, [])

  const persistDraft = useCallback(async (): Promise<LocalFeedback | null> => {
    if (!draftTarget || draftText.trim().length === 0) {
      setFeedbackError('Choose a target and enter feedback before saving.')
      return null
    }
    const draft: LocalFeedback = {
      id: draftId,
      documentId: document.id,
      createdAt: draftCreatedAt,
      updatedAt: new Date().toISOString(),
      status: 'draft',
      text: draftText.trim(),
      target: draftTarget
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
  }, [document.id, draftCreatedAt, draftId, draftTarget, draftText])

  const editFeedback = useCallback((item: LocalFeedback): void => {
    if (item.status !== 'draft') {
      return
    }
    setDraftId(item.id)
    setDraftCreatedAt(item.createdAt)
    setDraftTarget(item.target)
    setDraftText(item.text)
    setFeedbackPanelOpen(true)
    setFeedbackError(null)
  }, [])

  const deleteFeedback = useCallback(
    async (feedbackId: string): Promise<void> => {
      try {
        await window.desktop.deleteFeedback(document.id, feedbackId)
        setFeedbackState((current) => ({
          ...current,
          feedback: current.feedback.filter((item) => item.id !== feedbackId)
        }))
        if (draftId === feedbackId) {
          startFreshDraft()
        }
      } catch (error) {
        setFeedbackError(messageFromError(error))
      }
    },
    [document.id, draftId, startFreshDraft]
  )

  const resolveFeedback = useCallback(
    async (feedbackId: string): Promise<void> => {
      try {
        const resolved = await window.desktop.resolveFeedback(
          document.id,
          feedbackId,
          new Date().toISOString()
        )
        setFeedbackState((current) => ({
          ...current,
          feedback: current.feedback.map((item) =>
            item.id === resolved.id ? resolved : item
          )
        }))
      } catch (error) {
        setFeedbackError(messageFromError(error))
      }
    },
    [document.id]
  )

  const copyFeedback = useCallback(async (): Promise<void> => {
    const currentDraft = await persistDraft()
    if (!currentDraft) {
      return
    }
    const drafts = [
      ...feedbackState.feedback.filter(
        (item) => item.status === 'draft' && item.id !== currentDraft.id
      ),
      currentDraft
    ].filter((item) => item.text.trim().length > 0)
    try {
      const submission = await window.desktop.copyFeedbackSubmission({
        id: crypto.randomUUID(),
        documentId: document.id,
        feedbackIds: drafts.map((item) => item.id),
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
    feedbackState.feedback,
    persistDraft,
    startFreshDraft
  ])

  const copyExistingSubmission = useCallback(
    async (submissionId: string): Promise<void> => {
      try {
        await window.desktop.copyExistingFeedbackSubmission(
          document.id,
          submissionId
        )
        setFeedbackError('Copied the saved submission to the clipboard again.')
      } catch (error) {
        setFeedbackError(messageFromError(error))
      }
    },
    [document.id]
  )

  const targetSelectedElements = useCallback((): void => {
    const api = apiRef.current
    if (!api) {
      return
    }
    const selected = api.getAppState().selectedElementIds
    const sceneElements = api
      .getSceneElements()
      .filter((element) => !element.isDeleted)
    const targetIds = new Set(
      sceneElements
        .filter((element) => selected[element.id])
        .map((element) => element.id)
    )
    for (const element of sceneElements) {
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
    const elements = sceneElements.filter((element) => targetIds.has(element.id))
    if (elements.length === 0) {
      setFeedbackError('Select one or more elements on the canvas first.')
      return
    }
    const minX = Math.min(...elements.map((element) => element.x))
    const minY = Math.min(...elements.map((element) => element.y))
    const maxX = Math.max(...elements.map((element) => element.x + element.width))
    const maxY = Math.max(...elements.map((element) => element.y + element.height))
    setDraftTarget({
      type: 'elements',
      elementIds: elements.map((element) => element.id),
      originalBounds: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      }
    })
    setCaptureMode(null)
    setFeedbackError(null)
  }, [])

  const scenePointFromPointer = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const api = apiRef.current
      const shell = canvasShellRef.current
      if (!api || !shell) {
        return null
      }
      const bounds = shell.getBoundingClientRect()
      const appState = api.getAppState()
      return {
        x: (clientX - bounds.left) / appState.zoom.value - appState.scrollX,
        y: (clientY - bounds.top) / appState.zoom.value - appState.scrollY
      }
    },
    []
  )

  const handleCapturePointerDown = useCallback(
    (pointerEvent: React.PointerEvent<HTMLDivElement>): void => {
      const point = scenePointFromPointer(pointerEvent.clientX, pointerEvent.clientY)
      if (!point) {
        return
      }
      if (captureMode === 'point') {
        setDraftTarget({ type: 'point', point })
        setCaptureMode(null)
        setFeedbackPanelOpen(true)
        return
      }
      regionStartRef.current = point
      pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId)
      setRegionPreview({ ...point, width: 0, height: 0 })
    },
    [captureMode, scenePointFromPointer]
  )

  const handleCapturePointerMove = useCallback(
    (pointerEvent: React.PointerEvent<HTMLDivElement>): void => {
      const start = regionStartRef.current
      if (captureMode !== 'region' || !start) {
        return
      }
      const point = scenePointFromPointer(pointerEvent.clientX, pointerEvent.clientY)
      if (!point) {
        return
      }
      setRegionPreview({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y)
      })
    },
    [captureMode, scenePointFromPointer]
  )

  const handleCapturePointerUp = useCallback((): void => {
    if (
      captureMode === 'region' &&
      regionPreview &&
      regionPreview.width >= 2 &&
      regionPreview.height >= 2
    ) {
      setDraftTarget({ type: 'region', region: regionPreview })
      setCaptureMode(null)
      setRegionPreview(null)
      setFeedbackPanelOpen(true)
    }
    regionStartRef.current = null
  }, [captureMode, regionPreview])

  const finishRecording = useCallback(async (): Promise<void> => {
    const recording = recordingRef.current
    if (!recording) {
      return
    }
    recordingRef.current = null
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
          setDraftText((current) =>
            current.trim().length > 0
              ? `${current.trim()} ${result.text}`
              : result.text
          )
          setFeedbackError(null)
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
  }, [dictationLanguage, document.id])

  const startRecording = useCallback(async (): Promise<void> => {
    if (
      recordingStartRef.current ||
      recordingRef.current ||
      dictationJobIdRef.current
    ) {
      return
    }
    if (!draftTarget) {
      setFeedbackError('Choose a feedback target before starting dictation.')
      return
    }
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
        draftId,
        target: draftTarget
      }
      recording.timeout = setTimeout(() => {
        if (recordingRef.current === recording) {
          void finishRecording()
        }
      }, MAX_AUDIO_DURATION_SECONDS * 1000)
      recordingRef.current = recording
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
  }, [draftId, draftTarget, finishRecording])

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

  return (
    <section
      className={`document-pane${active ? ' document-pane--active' : ''}`}
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
            Comments ({feedbackState.feedback.filter((item) => item.status !== 'resolved').length})
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

      <div className="canvas-shell" ref={canvasShellRef}>
        <Excalidraw
          key={editorSeed.key}
          initialData={initialData}
          excalidrawAPI={(api) => {
            apiRef.current = api
          }}
          onChange={handleEditorChange}
          theme={theme}
          autoFocus={active}
          handleKeyboardGlobally={active}
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
          {feedbackState.feedback
            .filter((item) => item.status !== 'resolved')
            .map((item, index) => {
              const bounds =
                item.target.type === 'elements'
                  ? currentElementTargetBounds(item.target)
                  : item.target.type === 'region'
                    ? item.target.region
                    : item.target.type === 'point'
                      ? {
                          ...item.target.point,
                          width: 0,
                          height: 0
                        }
                      : null
              return bounds ? (
                <div
                  key={item.id}
                  className={`feedback-anchor feedback-anchor--${item.target.type}`}
                  style={toOverlayBounds(bounds)}
                >
                  <span>{index + 1}</span>
                </div>
              ) : (
                <div
                  key={item.id}
                  className="feedback-anchor feedback-anchor--drawing"
                >
                  <span>{index + 1}</span>
                </div>
              )
            })}
          {regionPreview && (
            <div
              className="feedback-anchor feedback-anchor--preview"
              style={toOverlayBounds(regionPreview)}
            />
          )}
        </div>
        {captureMode && (
          <div
            className="feedback-capture"
            role="button"
            tabIndex={0}
            aria-label={
              captureMode === 'point'
                ? 'Choose a comment point on the drawing'
                : 'Drag a comment region on the drawing'
            }
            onPointerDown={handleCapturePointerDown}
            onPointerMove={handleCapturePointerMove}
            onPointerUp={handleCapturePointerUp}
            onKeyDown={(keyboardEvent) => {
              if (keyboardEvent.key === 'Escape') {
                setCaptureMode(null)
                setRegionPreview(null)
              }
            }}
          >
            <span>
              {captureMode === 'point'
                ? 'Click a point for this comment'
                : 'Drag a region for this comment'}
            </span>
          </div>
        )}
        {feedbackPanelOpen && (
          <aside className="feedback-panel" aria-label="Drawing feedback">
            <header>
              <div>
                <span className="dialog-kicker">Local feedback</span>
                <h2>Comment on this drawing</h2>
              </div>
              <button
                type="button"
                aria-label="Close feedback panel"
                onClick={() => setFeedbackPanelOpen(false)}
              >
                ×
              </button>
            </header>

            <section className="feedback-composer">
              <span className="feedback-section-label">Target</span>
              <div className="feedback-target-actions">
                <button
                  type="button"
                  disabled={dictationState !== 'idle'}
                  onClick={targetSelectedElements}
                >
                  Selection
                </button>
                <button
                  type="button"
                  disabled={dictationState !== 'idle'}
                  onClick={() => {
                    setCaptureMode('point')
                    setFeedbackPanelOpen(false)
                  }}
                >
                  Point
                </button>
                <button
                  type="button"
                  disabled={dictationState !== 'idle'}
                  onClick={() => {
                    setCaptureMode('region')
                    setFeedbackPanelOpen(false)
                  }}
                >
                  Region
                </button>
                <button
                  type="button"
                  disabled={dictationState !== 'idle'}
                  onClick={() => setDraftTarget({ type: 'drawing' })}
                >
                  Drawing
                </button>
              </div>
              <div className="feedback-target-summary">
                {draftTarget ? targetLabel(draftTarget) : 'No target selected'}
              </div>

              <label className="feedback-text-label">
                <span>Feedback</span>
                <textarea
                  value={draftText}
                  maxLength={10_000}
                  rows={5}
                  disabled={dictationState !== 'idle'}
                  placeholder="Describe the requested change or question."
                  onChange={(changeEvent) => setDraftText(changeEvent.target.value)}
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
                  <button type="button" onClick={() => void startRecording()}>
                    Dictate
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
                    onClick={() => void finishRecording()}
                  >
                    Stop and transcribe
                  </button>
                )}
              </div>
              {dictationState !== 'idle' && (
                <p className="feedback-progress" role="status">
                  {dictationState === 'starting'
                    ? 'Requesting microphone access…'
                    : dictationState === 'recording'
                      ? 'Recording locally…'
                      : 'Transcribing locally…'}
                </p>
              )}
              {feedbackError && (
                <p className="feedback-message" role="status">
                  {feedbackError}
                </p>
              )}
              <div className="feedback-composer-actions">
                <button
                  type="button"
                  disabled={dictationState !== 'idle'}
                  onClick={startFreshDraft}
                >
                  New
                </button>
                <button
                  type="button"
                  disabled={dictationState !== 'idle'}
                  onClick={() => void persistDraft()}
                >
                  Save draft
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={dictationState !== 'idle'}
                  onClick={() => void copyFeedback()}
                >
                  Copy for agent
                </button>
              </div>
            </section>

            <section className="feedback-list">
              <div className="feedback-list-heading">
                <span className="feedback-section-label">Saved feedback</span>
                <span>{feedbackState.feedback.length}</span>
              </div>
              {feedbackState.feedback.length === 0 ? (
                <p className="feedback-empty">No saved feedback yet.</p>
              ) : (
                feedbackState.feedback.map((item) => (
                  <article
                    key={item.id}
                    className={`feedback-card feedback-card--${item.status}`}
                  >
                    <div>
                      <strong>{targetLabel(item.target)}</strong>
                      <span>{item.status.replace('-', ' ')}</span>
                    </div>
                    <p>{item.text}</p>
                    <footer>
                      {item.status === 'draft' && (
                        <button
                          type="button"
                          disabled={dictationState !== 'idle'}
                          onClick={() => editFeedback(item)}
                        >
                          Edit
                        </button>
                      )}
                      {item.status !== 'resolved' && (
                        <button
                          type="button"
                          disabled={dictationState !== 'idle'}
                          onClick={() => void resolveFeedback(item.id)}
                        >
                          Resolve
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={dictationState !== 'idle'}
                        onClick={() => void deleteFeedback(item.id)}
                      >
                        Delete
                      </button>
                    </footer>
                  </article>
                ))
              )}
              {feedbackState.submissions.length > 0 && (
                <div className="feedback-history">
                  <span className="feedback-section-label">Copy history</span>
                  {feedbackState.submissions.map((submission) => (
                    <div key={submission.id}>
                      <div>
                        <span>
                          {submission.feedback.length} item
                          {submission.feedback.length === 1 ? '' : 's'}
                        </span>
                        <time dateTime={submission.createdAt}>
                          {new Date(submission.createdAt).toLocaleString()}
                        </time>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void copyExistingSubmission(submission.id)
                        }
                      >
                        Copy again
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
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
  const [editorMeta, setEditorMeta] = useState<Record<string, EditorMeta>>({})
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [commands, setCommands] = useState<Record<string, EditorCommand>>({})
  const [detail, setDetail] = useState<string | null>(null)
  const [systemTheme, setSystemTheme] = useState<Theme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference)
  const theme = themePreference === 'system' ? systemTheme : themePreference

  const activateDocument = useCallback((documentId: string | null): void => {
    setActiveDocumentId(documentId)
    window.desktop.setActiveDocument(documentId)
  }, [])

  const handleDocumentEvent = useCallback(
    (event: DocumentEvent): void => {
      if (event.type === 'activate') {
        activateDocument(event.documentId)
        return
      }

      const documentId =
        event.type === 'opened' ? event.document.id : event.documentId
      const version = ++eventVersionRef.current
      setTabs((current) => {
        const existing = current.find((tab) => tab.document.id === documentId)
        if (event.type === 'opened') {
          const next: TabEntry = {
            document: event.document,
            event,
            eventVersion: version
          }
          return existing
            ? current.map((tab) => (tab.document.id === documentId ? next : tab))
            : [...current, next]
        }
        return current.map((tab) =>
          tab.document.id === documentId
            ? { ...tab, event, eventVersion: version }
            : tab
        )
      })
      if (event.type === 'opened') {
        activateDocument(documentId)
      }
    },
    [activateDocument]
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
      activateDocument(documentId)
    },
    [activateDocument]
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
    const removeDocumentListener = window.desktop.onDocumentEvent(handleDocumentEvent)
    const removeCommandListener = window.desktop.onAppCommand(handleCommand)
    void window.desktop.rendererReady().then((launchPath) => {
      if (launchPath) {
        void openPath(launchPath)
      }
    })
    return () => {
      removeDocumentListener()
      removeCommandListener()
    }
  }, [handleCommand, handleDocumentEvent, openPath])

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
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.document.id === documentId)
        const next = current.filter((tab) => tab.document.id !== documentId)
        if (activeDocumentId === documentId) {
          const nextActive = next[Math.min(index, next.length - 1)]?.document.id ?? null
          queueMicrotask(() => activateDocument(nextActive))
        }
        return next
      })
    },
    [activateDocument, activeDocumentId]
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
      className={`app app--${theme}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="document-identity">
          <strong>Excalidraw Visualizer</strong>
          <span>Local diagrams and visual feedback</span>
        </div>
        <div className="header-actions">
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

      <nav className="document-tabs" aria-label="Open drawings">
        {tabs.map((tab) => {
          const meta = editorMeta[tab.document.id]
          const tabPath = meta?.path ?? tab.document.path
          return (
            <div
              key={tab.document.id}
              className={`document-tab${
                tab.document.id === activeDocumentId ? ' document-tab--active' : ''
              }`}
            >
              <button
                type="button"
                className="document-tab__select"
                title={tabPath ?? 'Untitled drawing'}
                onClick={() => activateDocument(tab.document.id)}
              >
                <span>{documentName(tabPath)}</span>
                {meta?.dirty && <span aria-label="Unsaved changes">●</span>}
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

      {detail && (
        <div className="global-banner" role="alert">
          <span>{detail}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setDetail(null)}>
            ×
          </button>
        </div>
      )}

      <main className="workspace">
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
            <DocumentEditor
              key={tab.document.id}
              document={tab.document}
              event={tab.event}
              eventVersion={tab.eventVersion}
              command={commands[tab.document.id] ?? null}
              active={tab.document.id === activeDocumentId}
              theme={theme}
              onMetaChange={updateMeta}
            />
          ))
        )}
      </main>
    </div>
  )
}
