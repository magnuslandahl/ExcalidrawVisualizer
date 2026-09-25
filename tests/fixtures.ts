import type { ExcalidrawElementData, ExcalidrawScene } from '../src/shared/scene'

export const element = (
  id: string,
  version = 1,
  overrides: Partial<ExcalidrawElementData> = {}
): ExcalidrawElementData => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: 'a0',
  roundness: null,
  seed: 1,
  version,
  versionNonce: version * 101,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...overrides
})

export const scene = (
  elements: ExcalidrawElementData[] = [],
  overrides: Partial<ExcalidrawScene> = {}
): ExcalidrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: '#ffffff'
  },
  files: {},
  ...overrides
})
