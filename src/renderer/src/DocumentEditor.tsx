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
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  mergeScenes,
  scenesEquivalent,
  valuesEquivalent,
  type MergeConflict
} from '../../shared/merge'
import {
  parseSceneText,
  type ExcalidrawScene
} from '../../shared/scene'
import type {
  DocumentEvent,
  DocumentStatus,
  OpenedDocument
} from '../../shared/contracts'

type ConflictState = {
  base: ExcalidrawScene
  local: ExcalidrawScene
  external: ExcalidrawScene
  details: MergeConflict
}

type EditorSeed = {
  key: number
  scene: ExcalidrawScene
}

export type DocumentEditorMeta = {
  path: string
  status: DocumentStatus
  detail: string | null
  dirty: boolean
  conflict: boolean
  canvasBackground: string
}

export type DocumentEditorHandle = {
  save(saveAs?: boolean): Promise<boolean>
  reload(): Promise<void>
  fitToContent(): void
  refresh(): void
  changeCanvasBackground(color: string): void
  dismissDetail(): void
  prepareDetach(): Promise<boolean>
}

type DocumentEditorProps = {
  initialDocument: OpenedDocument
  active: boolean
  focused: boolean
  theme: 'light' | 'dark'
  onActivate: () => void
  onMetaChange: (meta: DocumentEditorMeta) => void
  onPathChange: (
    previousPath: string,
    document: OpenedDocument
  ) => void
}

const defaultCanvasBackground = '#ffffff'
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

const readCanvasBackground = (scene: ExcalidrawScene): string => {
  const color = scene.appState.viewBackgroundColor
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : defaultCanvasBackground
}

export const DocumentEditor = forwardRef<
  DocumentEditorHandle,
  DocumentEditorProps
>(function DocumentEditor(
  {
    initialDocument,
    active,
    focused,
    theme,
    onActivate,
    onMetaChange,
    onPathChange
  },
  ref
): React.JSX.Element {
  const initialScene = useMemo(
    () => normalizeScene(initialDocument.scene),
    [initialDocument.scene]
  )
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const baseSceneRef = useRef<ExcalidrawScene>(initialScene)
  const currentSceneRef = useRef<ExcalidrawScene>(initialScene)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const conflictRef = useRef<ConflictState | null>(null)
  const applyingRef = useRef(false)
  const pathRef = useRef(initialDocument.path)

  const [path, setPath] = useState(initialDocument.path)
  const [status, setStatus] = useState<DocumentStatus>('saved')
  const [detail, setDetail] = useState<string | null>(null)
  const [dirty, setDirtyState] = useState(false)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [editorSeed, setEditorSeed] = useState<EditorSeed>({
    key: 1,
    scene: initialScene
  })
  const [canvasBackground, setCanvasBackground] = useState(
    readCanvasBackground(initialScene)
  )

  const setDirty = useCallback((nextDirty: boolean): void => {
    dirtyRef.current = nextDirty
    setDirtyState(nextDirty)
  }, [])

  useEffect(() => {
    onMetaChange({
      path,
      status,
      detail,
      dirty,
      conflict: conflict !== null,
      canvasBackground
    })
  }, [
    canvasBackground,
    conflict,
    detail,
    dirty,
    onMetaChange,
    path,
    status
  ])

  useEffect(() => {
    if (!active) {
      return
    }
    const frame = requestAnimationFrame(() => apiRef.current?.refresh())
    return () => cancelAnimationFrame(frame)
  }, [active])

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current)
      }
    },
    []
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
      const currentPath = pathRef.current
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }

      setStatus('saving')
      setDetail(null)
      try {
        const result = saveAs
          ? await window.desktop.saveAs({ path: currentPath, scene })
          : await window.desktop.save({ path: currentPath, scene })

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

        if (result.path !== currentPath) {
          const renamedDocument: OpenedDocument = {
            path: result.path,
            scene,
            fingerprint: result.fingerprint
          }
          pathRef.current = result.path
          setPath(result.path)
          onPathChange(currentPath, renamedDocument)
        }
        baseSceneRef.current = scene
        const unchangedDuringSave = scenesEquivalent(currentSceneRef.current, scene)
        setDirty(!unchangedDuringSave)
        setStatus(unchangedDuringSave ? 'saved' : 'modified')
        if (!unchangedDuringSave) {
          scheduleSaveRef.current()
        }
        return true
      } catch (error) {
        setStatus('save-failed')
        setDetail(messageFromError(error))
        setDirty(true)
        return false
      }
    },
    [onPathChange, setDirty]
  )

  const scheduleSave = useCallback((): void => {
    if (conflictRef.current) {
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

  const replaceDocument = useCallback(
    (document: OpenedDocument): void => {
      const normalized = normalizeScene(document.scene)
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      pathRef.current = document.path
      baseSceneRef.current = normalized
      currentSceneRef.current = normalized
      conflictRef.current = null
      setPath(document.path)
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
    (document: OpenedDocument): void => {
      const external = normalizeScene(
        document.scene,
        apiRef.current?.getAppState() ?? null
      )
      const base = baseSceneRef.current
      const local = currentSceneRef.current

      if (!dirtyRef.current) {
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
        details: result.conflict
      }
      conflictRef.current = nextConflict
      setConflict(nextConflict)
      setStatus('conflict')
      setDetail(null)
      setDirty(true)
    },
    [applyToEditor, scheduleSave, setDirty, setTemporaryStatus]
  )

  useEffect(() => {
    const removeDocumentListener = window.desktop.onDocumentEvent(
      (event: DocumentEvent) => {
        const eventPath =
          event.type === 'external-change' ? event.document.path : event.path
        if (eventPath !== pathRef.current) {
          return
        }
        if (event.type === 'external-change') {
          handleExternalChange(event.document)
        } else if (event.type === 'invalid-external') {
          setStatus('invalid-external')
          setDetail(event.message)
        } else if (event.type === 'file-missing') {
          setStatus('file-missing')
          setDetail('The file was deleted. Watching for it to be recreated.')
        } else if (event.type === 'save-failed') {
          setStatus('save-failed')
          setDetail(event.message)
          setDirty(true)
        }
      }
    )
    return removeDocumentListener
  }, [handleExternalChange, setDirty])

  const reload = useCallback(async (): Promise<void> => {
    if (
      (dirtyRef.current || conflictRef.current) &&
      !window.confirm('Discard local changes and reload this file from disk?')
    ) {
      return
    }
    setStatus('loading')
    setDetail(null)
    try {
      replaceDocument(await window.desktop.reload(pathRef.current))
    } catch (error) {
      setStatus('save-failed')
      setDetail(messageFromError(error))
    }
  }, [replaceDocument])

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

  useImperativeHandle(
    ref,
    () => ({
      save: saveCurrent,
      reload,
      fitToContent,
      refresh: () => apiRef.current?.refresh(),
      changeCanvasBackground,
      dismissDetail: () => setDetail(null),
      prepareDetach: async () => {
        if (conflictRef.current) {
          setDetail('Resolve this conflict before opening the tab in a new window.')
          setStatus('conflict')
          return false
        }
        return dirtyRef.current ? saveCurrent(false) : true
      }
    }),
    [changeCanvasBackground, fitToContent, reload, saveCurrent]
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
      const scene = toScene(elements, appState, files)
      setCanvasBackground(appState.viewBackgroundColor)
      const previous = currentSceneRef.current
      if (scenesEquivalent(previous, scene)) {
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

  const keepLocal = useCallback((): void => {
    const pending = conflictRef.current
    if (!pending) {
      return
    }
    baseSceneRef.current = pending.external
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
    currentSceneRef.current = pending.external
    conflictRef.current = null
    setConflict(null)
    setDetail(null)
    setDirty(false)
    setCanvasBackground(readCanvasBackground(pending.external))
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
      conflictRef.current = null
      setConflict(null)
      setDetail(null)
      setDirty(false)
    }
  }, [saveCurrent, setDirty])

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
      className={`document-editor${active ? ' document-editor--active' : ''}`}
      aria-hidden={!active}
      onMouseDownCapture={onActivate}
    >
      <div className="canvas-shell">
        <Excalidraw
          key={editorSeed.key}
          initialData={editorSeed.scene as unknown as ExcalidrawInitialDataState}
          excalidrawAPI={(api) => {
            apiRef.current = api
          }}
          onChange={handleEditorChange}
          theme={theme}
          autoFocus={active && focused}
          handleKeyboardGlobally={active && focused}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: true,
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: true
            }
          }}
        />
      </div>

      {active && focused && conflict && (
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
})
