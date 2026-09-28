import { describe, expect, it } from 'vitest'
import {
  initialWorkspaceState,
  workspaceReducer,
  type WorkspaceTab
} from '../src/shared/workspace-state'
import { scene } from './fixtures'

const tab = (
  id: string,
  path: string,
  pane: WorkspaceTab['pane'] = 'primary'
): WorkspaceTab => ({
  id,
  pane,
  document: { path, scene: scene(), fingerprint: id }
})

describe('workspaceReducer', () => {
  it('opens multiple documents and activates an existing path only once', () => {
    const opened = workspaceReducer(initialWorkspaceState, {
      type: 'open',
      tabs: [
        tab('one', 'C:\\drawings\\one.excalidraw'),
        tab('two', 'C:\\drawings\\two.excalidraw')
      ]
    })
    const reopened = workspaceReducer(opened, {
      type: 'open',
      tabs: [tab('duplicate', 'C:\\drawings\\one.excalidraw')]
    })

    expect(reopened.tabs.map(({ id }) => id)).toEqual(['one', 'two'])
    expect(reopened.active.primary).toBe('one')
  })

  it('moves a tab into a side-by-side secondary pane', () => {
    const opened = workspaceReducer(initialWorkspaceState, {
      type: 'open',
      tabs: [tab('one', 'one.excalidraw'), tab('two', 'two.excalidraw')]
    })
    const split = workspaceReducer(opened, {
      type: 'move',
      tabId: 'two',
      pane: 'secondary'
    })

    expect(split.tabs.find(({ id }) => id === 'two')?.pane).toBe('secondary')
    expect(split.active).toEqual({ primary: 'one', secondary: 'two' })
  })

  it('collapses the remaining secondary pane back to primary', () => {
    const split = workspaceReducer(initialWorkspaceState, {
      type: 'open',
      tabs: [
        tab('one', 'one.excalidraw', 'primary'),
        tab('two', 'two.excalidraw', 'secondary')
      ]
    })
    const closed = workspaceReducer(split, { type: 'close', tabId: 'one' })

    expect(closed.tabs).toMatchObject([{ id: 'two', pane: 'primary' }])
    expect(closed.active).toEqual({ primary: 'two' })
  })
})
