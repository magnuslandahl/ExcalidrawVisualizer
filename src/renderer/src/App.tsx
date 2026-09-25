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
  AppCommand,
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

type ThemePreference = 'system' | 'light' | 'dark'

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

export function App(): React.JSX.Element {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const baseSceneRef = useRef<ExcalidrawScene | null>(null)
  const currentSceneRef = useRef<ExcalidrawScene | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const conflictRef = useRef<ConflictState | null>(null)
  const applyingRef = useRef(false)
  const pathRef = useRef<string | null>(null)

  const [path, setPath] = useState<string | null>(null)
  const [status, setStatus] = useState<DocumentStatus>('no-file')
  const [detail, setDetail] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null)
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference)
  const [canvasBackground, setCanvasBackground] = useState(defaultCanvasBackground)
  const theme = themePreference === 'system' ? systemTheme : themePreference

  const setDirty = useCallback((dirty: boolean): void => {
    dirtyRef.current = dirty
    window.desktop.setDirty(dirty || conflictRef.current !== null)
  }, [])

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
      if (!scene) {
        return false
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }

      setStatus('saving')
      setDetail(null)
      const result = saveAs
        ? await window.desktop.saveAs({ scene })
        : await window.desktop.save({ scene })

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

      pathRef.current = result.path
      setPath(result.path)
      baseSceneRef.current = scene
      const unchangedDuringSave =
        currentSceneRef.current !== null &&
        scenesEquivalent(currentSceneRef.current, scene)
      setDirty(!unchangedDuringSave)
      setStatus(unchangedDuringSave ? 'saved' : 'modified')
      if (!unchangedDuringSave) {
        scheduleSaveRef.current()
      }
      return true
    },
    [setDirty]
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
        key: (current?.key ?? 0) + 1,
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
        key: (current?.key ?? 0) + 1,
        scene: normalized
      }))
    },
    [setDirty]
  )

  const handleExternalChange = useCallback(
    (document: OpenedDocument): void => {
      const external = normalizeScene(document.scene, apiRef.current?.getAppState() ?? null)
      const base = baseSceneRef.current
      const local = currentSceneRef.current
      if (!base || !local) {
        openDocument({ ...document, scene: external })
        return
      }

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
    [applyToEditor, openDocument, scheduleSave, setDirty, setTemporaryStatus]
  )

  const handleDocumentEvent = useCallback(
    (event: DocumentEvent): void => {
      if (event.type === 'opened') {
        openDocument(event.document)
      } else if (event.type === 'external-change') {
        handleExternalChange(event.document)
      } else if (event.type === 'invalid-external') {
        setStatus('invalid-external')
        setDetail(event.message)
      } else if (event.type === 'file-missing') {
        setStatus('file-missing')
        setDetail('The active file was deleted. Watching for it to be recreated.')
      } else if (event.type === 'save-failed') {
        setStatus('save-failed')
        setDetail(event.message)
        setDirty(true)
      }
    },
    [handleExternalChange, openDocument, setDirty]
  )

  const confirmDiscard = useCallback((): boolean => {
    if (!dirtyRef.current && !conflictRef.current) {
      return true
    }
    return window.confirm('Discard the current unsaved changes and open another file?')
  }, [])

  const openPath = useCallback(
    async (requestedPath: string): Promise<void> => {
      if (!confirmDiscard()) {
        return
      }
      setStatus('loading')
      setDetail(null)
      try {
        await window.desktop.openPath(requestedPath)
      } catch (error) {
        setStatus(pathRef.current ? 'save-failed' : 'no-file')
        setDetail(messageFromError(error))
      }
    },
    [confirmDiscard]
  )

  const openDialog = useCallback(async (): Promise<void> => {
    if (!confirmDiscard()) {
      return
    }
    setStatus('loading')
    setDetail(null)
    try {
      const opened = await window.desktop.openDialog()
      if (!opened) {
        setStatus(pathRef.current ? (dirtyRef.current ? 'modified' : 'saved') : 'no-file')
      }
    } catch (error) {
      setStatus(pathRef.current ? 'save-failed' : 'no-file')
      setDetail(messageFromError(error))
    }
  }, [confirmDiscard])

  const reload = useCallback(async (): Promise<void> => {
    if (!pathRef.current) {
      return
    }
    if (
      (dirtyRef.current || conflictRef.current) &&
      !window.confirm('Discard local changes and reload the file from disk?')
    ) {
      return
    }
    setStatus('loading')
    setDetail(null)
    try {
      await window.desktop.reload()
    } catch (error) {
      setStatus('save-failed')
      setDetail(messageFromError(error))
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

  const handleCommand = useCallback(
    (command: AppCommand): void => {
      if (command.type === 'open') {
        void openDialog()
      } else if (command.type === 'open-path') {
        void openPath(command.path)
      } else if (command.type === 'save') {
        void saveCurrent(false)
      } else if (command.type === 'save-as') {
        void saveCurrent(true)
      } else if (command.type === 'reload') {
        void reload()
      } else {
        fitToContent()
      }
    },
    [fitToContent, openDialog, openPath, reload, saveCurrent]
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
      if (previous && scenesEquivalent(previous, scene)) {
        return
      }
      currentSceneRef.current = scene
      const base = baseSceneRef.current
      const dirty = base === null || !scenesEquivalent(base, scene)
      setDirty(dirty)
      if (dirty && !conflictRef.current) {
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

  const initialData = useMemo(
    () =>
      editorSeed
        ? (editorSeed.scene as unknown as ExcalidrawInitialDataState)
        : null,
    [editorSeed]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault()
      const file = event.dataTransfer.files[0]
      if (!file) {
        return
      }
      const droppedPath = window.desktop.getDroppedFilePath(file)
      if (!droppedPath.toLowerCase().endsWith('.excalidraw')) {
        setDetail('Only .excalidraw files can be opened')
        return
      }
      void openPath(droppedPath)
    },
    [openPath]
  )

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
    <div
      className={`app app--${theme}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="document-identity">
          <strong>{path ? path.split(/[\\/]/).at(-1) : 'Excalidraw Visualizer'}</strong>
          <span title={path ?? undefined}>{path ?? 'Offline diagram editor and live viewer'}</span>
        </div>
        <div className="header-actions">
          <span className={`status status--${status}`} aria-live="polite">
            {statusLabels[status]}
          </span>
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
          <label
            className={`color-control${path ? '' : ' color-control--disabled'}`}
            title={path ? 'Choose the canvas background color' : 'Open a drawing first'}
          >
            <span>Canvas</span>
            <input
              type="color"
              aria-label="Canvas background color"
              value={canvasBackground}
              disabled={!path}
              onChange={(event) => changeCanvasBackground(event.target.value)}
            />
          </label>
          <button type="button" onClick={() => void openDialog()}>
            Open
          </button>
          {path && (
            <>
              <button type="button" onClick={fitToContent}>
                Fit to Content
              </button>
              <button type="button" onClick={() => void reload()}>
                Reload
              </button>
            </>
          )}
        </div>
      </header>

      {detail && (
        <div className={`banner banner--${status}`} role="alert">
          <span>{detail}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setDetail(null)}>
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        {!editorSeed || !initialData ? (
          <section className="welcome">
            <div className="welcome-card">
              <div className="welcome-mark" aria-hidden="true">
                EV
              </div>
              <h1>Open an Excalidraw drawing</h1>
              <p>
                Edit locally while this window watches the file for safe, automatic external
                updates.
              </p>
              <button type="button" className="primary-button" onClick={() => void openDialog()}>
                Open .excalidraw file
              </button>
              <small>You can also drop a file anywhere in this window.</small>
            </div>
          </section>
        ) : (
          <div className="canvas-shell">
            <Excalidraw
              key={editorSeed.key}
              initialData={initialData}
              excalidrawAPI={(api) => {
                apiRef.current = api
              }}
              onChange={handleEditorChange}
              theme={theme}
              autoFocus
              handleKeyboardGlobally
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
        )}
      </main>

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
    </div>
  )
}
