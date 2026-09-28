import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import type {
  AppCommand,
  DocumentStatus,
  OpenedDocument
} from '../../shared/contracts'
import {
  DocumentEditor,
  type DocumentEditorHandle,
  type DocumentEditorMeta
} from './DocumentEditor'
import {
  initialWorkspaceState,
  workspaceReducer,
  type PaneId,
  type WorkspaceTab
} from '../../shared/workspace-state'

type ThemePreference = 'system' | 'light' | 'dark'
type ContextMenuState = {
  tabId: string
  x: number
  y: number
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

const readThemePreference = (): ThemePreference => {
  const stored = window.localStorage.getItem(themePreferenceStorageKey)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

const fileName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : 'The operation failed'

export function App(): React.JSX.Element {
  const [workspace, dispatch] = useReducer(
    workspaceReducer,
    initialWorkspaceState
  )
  const [metas, setMetas] = useState<Record<string, DocumentEditorMeta>>({})
  const [globalDetail, setGlobalDetail] = useState<string | null>(null)
  const [focusedPane, setFocusedPane] = useState<PaneId>('primary')
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference)
  const tabCounterRef = useRef(0)
  const editorRefs = useRef(new Map<string, DocumentEditorHandle>())
  const workspaceRef = useRef(workspace)
  const focusedPaneRef = useRef<PaneId>(focusedPane)

  const theme = themePreference === 'system' ? systemTheme : themePreference
  const split = workspace.tabs.some(({ pane }) => pane === 'secondary')
  const focusedTabId =
    workspace.active[focusedPane] ??
    workspace.active.primary ??
    workspace.active.secondary
  const focusedTabIdRef = useRef<string | undefined>(focusedTabId)
  const focusedTab = workspace.tabs.find(({ id }) => id === focusedTabId)
  const focusedMeta = focusedTabId ? metas[focusedTabId] : undefined
  const status = focusedMeta?.status ?? (focusedTab ? 'saved' : 'no-file')
  const detail = focusedMeta?.detail ?? globalDetail
  const canvasBackground =
    focusedMeta?.canvasBackground ?? defaultCanvasBackground

  useEffect(() => {
    workspaceRef.current = workspace
    focusedPaneRef.current = focusedPane
    focusedTabIdRef.current = focusedTabId
  }, [focusedPane, focusedTabId, workspace])

  const openDocuments = useCallback(
    (documents: readonly OpenedDocument[], pane?: PaneId): void => {
      if (documents.length === 0) {
        return
      }
      const targetPane = pane ?? focusedPaneRef.current
      setGlobalDetail(null)
      const tabs: WorkspaceTab[] = documents.map((document) => ({
        id: `document-${++tabCounterRef.current}`,
        pane: targetPane,
        document
      }))
      dispatch({ type: 'open', tabs })
      setFocusedPane(targetPane)
    },
    []
  )

  const openPath = useCallback(
    async (path: string, pane?: PaneId): Promise<void> => {
      const existing = workspaceRef.current.tabs.find(
        ({ document }) => document.path === path
      )
      if (existing) {
        dispatch({ type: 'activate', tabId: existing.id })
        setFocusedPane(existing.pane)
        return
      }
      try {
        openDocuments([await window.desktop.openPath(path)], pane)
      } catch (error) {
        setGlobalDetail(messageFromError(error))
      }
    },
    [openDocuments]
  )

  const openDialog = useCallback(async (): Promise<void> => {
    try {
      openDocuments(await window.desktop.openDialog())
    } catch (error) {
      setGlobalDetail(messageFromError(error))
    }
  }, [openDocuments])

  const openPaths = useCallback(
    async (paths: readonly string[], pane?: PaneId): Promise<void> => {
      const results = await Promise.allSettled(
        paths.map((path) => window.desktop.openPath(path))
      )
      const documents = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      openDocuments(documents, pane)
      const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      const firstFailure = failed[0]
      if (firstFailure) {
        setGlobalDetail(
          `${failed.length} drawing${failed.length === 1 ? '' : 's'} could not be opened: ${
            messageFromError(firstFailure.reason)
          }`
        )
      }
    },
    [openDocuments]
  )

  const activateTab = useCallback((tab: WorkspaceTab): void => {
    dispatch({ type: 'activate', tabId: tab.id })
    setFocusedPane(tab.pane)
    setGlobalDetail(null)
  }, [])

  const closeTab = useCallback(
    async (tabId: string, skipPrompt = false): Promise<void> => {
      const tab = workspaceRef.current.tabs.find(({ id }) => id === tabId)
      if (!tab) {
        return
      }
      const meta = metas[tabId]
      if (meta?.status === 'saving') {
        setGlobalDetail('Wait for the current save to finish before closing this tab.')
        return
      }
      if (
        !skipPrompt &&
        (meta?.dirty || meta?.conflict) &&
        !window.confirm(`Close ${fileName(tab.document.path)} without saving?`)
      ) {
        return
      }
      try {
        await window.desktop.closeDocument(tab.document.path)
      } catch (error) {
        setGlobalDetail(messageFromError(error))
        return
      }
      editorRefs.current.delete(tabId)
      setMetas((current) => {
        const next = { ...current }
        delete next[tabId]
        return next
      })
      dispatch({ type: 'close', tabId })
      setContextMenu(null)
    },
    [metas]
  )

  const detachTab = useCallback(
    async (tabId: string): Promise<void> => {
      const tab = workspaceRef.current.tabs.find(({ id }) => id === tabId)
      const editor = editorRefs.current.get(tabId)
      if (!tab || !editor || !(await editor.prepareDetach())) {
        return
      }
      try {
        await window.desktop.openInNewWindow(tab.document.path)
        await closeTab(tabId, true)
      } catch (error) {
        setGlobalDetail(messageFromError(error))
      }
      setContextMenu(null)
    },
    [closeTab]
  )

  const moveTab = useCallback(
    (tabId: string, pane: PaneId, beforeTabId?: string): void => {
      dispatch(
        beforeTabId
          ? { type: 'move', tabId, pane, beforeTabId }
          : { type: 'move', tabId, pane }
      )
      setFocusedPane(pane)
      setDraggingTabId(null)
      setContextMenu(null)
    },
    []
  )

  const handleCommand = useCallback(
    (command: AppCommand): void => {
      const activeTabId = focusedTabIdRef.current
      const editor = activeTabId
        ? editorRefs.current.get(activeTabId)
        : undefined
      if (command.type === 'open') {
        void openDialog()
      } else if (command.type === 'open-path') {
        void openPath(command.path)
      } else if (command.type === 'save') {
        void editor?.save(false)
      } else if (command.type === 'save-as') {
        void editor?.save(true)
      } else if (command.type === 'reload') {
        void editor?.reload()
      } else {
        editor?.fitToContent()
      }
    },
    [openDialog, openPath]
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
    window.desktop.setDirty(
      Object.values(metas).some(({ dirty, conflict }) => dirty || conflict)
    )
  }, [metas])

  useEffect(() => {
    const removeCommandListener = window.desktop.onAppCommand(handleCommand)
    void window.desktop.rendererReady().then((paths) => {
      void openPaths(paths, 'primary')
    })
    return removeCommandListener
  }, [handleCommand, openPaths])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const tabId of [
        workspace.active.primary,
        workspace.active.secondary
      ]) {
        if (tabId) {
          editorRefs.current.get(tabId)?.refresh()
        }
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [split, workspace.active.primary, workspace.active.secondary])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const close = (): void => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const handleDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault()
      const paths = [...event.dataTransfer.files]
        .map((file) => window.desktop.getDroppedFilePath(file))
        .filter((path) => path.toLowerCase().endsWith('.excalidraw'))
      if (paths.length === 0) {
        if (event.dataTransfer.files.length > 0) {
          setGlobalDetail('Only .excalidraw files can be opened')
        }
        return
      }
      void openPaths(paths)
    },
    [openPaths]
  )

  const panes = useMemo(
    () => (split ? (['primary', 'secondary'] as const) : (['primary'] as const)),
    [split]
  )

  const renderTabs = (pane: PaneId): React.JSX.Element => {
    const paneTabs = workspace.tabs.filter((tab) => tab.pane === pane)
    return (
      <div
        className="tab-strip"
        role="tablist"
        aria-label={pane === 'primary' ? 'Main drawing tabs' : 'Side drawing tabs'}
        onDragOver={(event) => {
          if (draggingTabId) {
            event.preventDefault()
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (draggingTabId) {
            moveTab(draggingTabId, pane)
          }
        }}
      >
        {paneTabs.map((tab) => {
          const selected = workspace.active[pane] === tab.id
          const meta = metas[tab.id]
          return (
            <div
              key={tab.id}
              className={`drawing-tab${selected ? ' drawing-tab--active' : ''}`}
              role="tab"
              aria-selected={selected}
              title={tab.document.path}
              draggable
              onClick={() => activateTab(tab)}
              onContextMenu={(event) => {
                event.preventDefault()
                activateTab(tab)
                setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
              }}
              onDragStart={(event) => {
                setDraggingTabId(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={() => setDraggingTabId(null)}
              onDragOver={(event) => {
                if (draggingTabId && draggingTabId !== tab.id) {
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (draggingTabId && draggingTabId !== tab.id) {
                  moveTab(draggingTabId, pane, tab.id)
                }
              }}
            >
              <span
                className={`tab-state tab-state--${meta?.status ?? 'saved'}`}
                aria-hidden="true"
              />
              <span className="tab-label">{fileName(tab.document.path)}</span>
              {(meta?.dirty || meta?.conflict) && (
                <span className="tab-dirty" aria-label="Unsaved changes">
                  •
                </span>
              )}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${fileName(tab.document.path)}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      className={`app app--${theme}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="document-identity">
          <strong>
            {focusedTab ? fileName(focusedTab.document.path) : 'Excalidraw Visualizer'}
          </strong>
          <span title={focusedTab?.document.path}>
            {focusedTab?.document.path ?? 'Offline diagram editor and live viewer'}
          </span>
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
            className={`color-control${focusedTab ? '' : ' color-control--disabled'}`}
            title={focusedTab ? 'Choose the canvas background color' : 'Open a drawing first'}
          >
            <span>Canvas</span>
            <input
              type="color"
              aria-label="Canvas background color"
              value={canvasBackground}
              disabled={!focusedTabId}
              onChange={(event) =>
                focusedTabId &&
                editorRefs.current
                  .get(focusedTabId)
                  ?.changeCanvasBackground(event.target.value)
              }
            />
          </label>
          <button type="button" onClick={() => void openDialog()}>
            Open
          </button>
          {focusedTabId && (
            <>
              <button
                type="button"
                onClick={() => editorRefs.current.get(focusedTabId)?.fitToContent()}
              >
                Fit to Content
              </button>
              <button
                type="button"
                onClick={() => void editorRefs.current.get(focusedTabId)?.reload()}
              >
                Reload
              </button>
            </>
          )}
        </div>
      </header>

      {detail && (
        <div className={`banner banner--${status}`} role="alert">
          <span>{detail}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              setGlobalDetail(null)
              if (focusedTabId) {
                editorRefs.current.get(focusedTabId)?.dismissDetail()
              }
            }}
          >
            ×
          </button>
        </div>
      )}

      <main className={`workspace${split ? ' workspace--split' : ''}`}>
        {workspace.tabs.length === 0 ? (
          <section className="welcome">
            <div className="welcome-card">
              <div className="welcome-mark" aria-hidden="true">
                EV
              </div>
              <h1>Open Excalidraw drawings</h1>
              <p>
                Keep several drawings open as tabs, drag a tab into a side view, or
                right-click it to move the drawing to another window.
              </p>
              <button type="button" className="primary-button" onClick={() => void openDialog()}>
                Open .excalidraw files
              </button>
              <small>You can also drop one or more files anywhere in this window.</small>
            </div>
          </section>
        ) : (
          <>
            {panes.map((pane) => (
              <div
                key={pane}
                className={`pane-tabs pane-tabs--${pane}${
                  focusedPane === pane ? ' pane-tabs--focused' : ''
                }`}
                onMouseDown={() => setFocusedPane(pane)}
              >
                {renderTabs(pane)}
              </div>
            ))}

            {workspace.tabs.map((tab) => (
              <div
                key={tab.id}
                className={`editor-slot editor-slot--${tab.pane}${
                  workspace.active[tab.pane] === tab.id
                    ? ' editor-slot--active'
                    : ''
                }`}
              >
                <DocumentEditor
                  ref={(editor) => {
                    if (editor) {
                      editorRefs.current.set(tab.id, editor)
                    } else {
                      editorRefs.current.delete(tab.id)
                    }
                  }}
                  initialDocument={tab.document}
                  active={workspace.active[tab.pane] === tab.id}
                  focused={
                    focusedPane === tab.pane &&
                    workspace.active[tab.pane] === tab.id
                  }
                  theme={theme}
                  onActivate={() => activateTab(tab)}
                  onMetaChange={(meta) =>
                    setMetas((current) => {
                      const previous = current[tab.id]
                      return previous &&
                        previous.path === meta.path &&
                        previous.status === meta.status &&
                        previous.detail === meta.detail &&
                        previous.dirty === meta.dirty &&
                        previous.conflict === meta.conflict &&
                        previous.canvasBackground === meta.canvasBackground
                        ? current
                        : { ...current, [tab.id]: meta }
                    })
                  }
                  onPathChange={(_previousPath, document) =>
                    dispatch({ type: 'rename', tabId: tab.id, document })
                  }
                />
              </div>
            ))}

            {draggingTabId && !split && workspace.tabs.length > 1 && (
              <div
                className="split-drop-target"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  moveTab(draggingTabId, 'secondary')
                }}
              >
                Drop here for side-by-side view
              </div>
            )}
          </>
        )}
      </main>

      {contextMenu && (() => {
        const tab = workspace.tabs.find(({ id }) => id === contextMenu.tabId)
        if (!tab) {
          return null
        }
        const oppositePane: PaneId =
          tab.pane === 'primary' ? 'secondary' : 'primary'
        return (
          <div
            className="tab-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {workspace.tabs.length > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => moveTab(tab.id, oppositePane)}
              >
                {tab.pane === 'primary' ? 'Move to Side View' : 'Move to Main View'}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => void detachTab(tab.id)}
            >
              Open in New Window
            </button>
            <div className="context-separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => void closeTab(tab.id)}
            >
              Close Tab
            </button>
          </div>
        )
      })()}
    </div>
  )
}
