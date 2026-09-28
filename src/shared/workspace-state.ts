import type { OpenedDocument } from './contracts'

export type PaneId = 'primary' | 'secondary'

export type WorkspaceTab = {
  id: string
  pane: PaneId
  document: OpenedDocument
}

export type WorkspaceState = {
  tabs: WorkspaceTab[]
  active: Partial<Record<PaneId, string>>
}

export type WorkspaceAction =
  | { type: 'open'; tabs: WorkspaceTab[] }
  | { type: 'activate'; tabId: string }
  | {
      type: 'move'
      tabId: string
      pane: PaneId
      beforeTabId?: string
    }
  | { type: 'close'; tabId: string }
  | { type: 'rename'; tabId: string; document: OpenedDocument }

export const initialWorkspaceState: WorkspaceState = {
  tabs: [],
  active: {}
}

const normalizeWorkspace = (
  tabsCandidate: WorkspaceTab[],
  activeCandidate: Partial<Record<PaneId, string>>
): WorkspaceState => {
  let tabs = tabsCandidate
  let active = { ...activeCandidate }
  const primaryTabs = tabs.filter(({ pane }) => pane === 'primary')
  const secondaryTabs = tabs.filter(({ pane }) => pane === 'secondary')

  if (primaryTabs.length === 0 && secondaryTabs.length > 0) {
    tabs = tabs.map((tab) => ({ ...tab, pane: 'primary' }))
    active = { primary: active.secondary ?? secondaryTabs[0]!.id }
  } else {
    for (const pane of ['primary', 'secondary'] as const) {
      const paneTabs = tabs.filter((tab) => tab.pane === pane)
      if (paneTabs.length === 0) {
        delete active[pane]
      } else if (!paneTabs.some(({ id }) => id === active[pane])) {
        active[pane] = paneTabs[0]!.id
      }
    }
  }

  return { tabs, active }
}

export const workspaceReducer = (
  state: WorkspaceState,
  action: WorkspaceAction
): WorkspaceState => {
  if (action.type === 'open') {
    const tabs = [...state.tabs]
    const active = { ...state.active }
    for (const candidate of action.tabs) {
      const existing = tabs.find(
        ({ document }) => document.path === candidate.document.path
      )
      if (existing) {
        active[existing.pane] = existing.id
      } else {
        tabs.push(candidate)
        active[candidate.pane] = candidate.id
      }
    }
    return normalizeWorkspace(tabs, active)
  }

  if (action.type === 'activate') {
    const tab = state.tabs.find(({ id }) => id === action.tabId)
    return tab
      ? { ...state, active: { ...state.active, [tab.pane]: tab.id } }
      : state
  }

  if (action.type === 'move') {
    const moving = state.tabs.find(({ id }) => id === action.tabId)
    if (!moving) {
      return state
    }
    const remaining = state.tabs.filter(({ id }) => id !== action.tabId)
    const moved = { ...moving, pane: action.pane }
    const beforeIndex = action.beforeTabId
      ? remaining.findIndex(({ id }) => id === action.beforeTabId)
      : -1
    if (beforeIndex >= 0) {
      remaining.splice(beforeIndex, 0, moved)
    } else {
      remaining.push(moved)
    }
    return normalizeWorkspace(remaining, {
      ...state.active,
      [action.pane]: moved.id
    })
  }

  if (action.type === 'close') {
    return normalizeWorkspace(
      state.tabs.filter(({ id }) => id !== action.tabId),
      state.active
    )
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === action.tabId ? { ...tab, document: action.document } : tab
    )
  }
}
