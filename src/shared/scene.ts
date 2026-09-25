export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ExcalidrawElementData = {
  id: string
  version: number
  versionNonce: number
  isDeleted?: boolean
  [key: string]: unknown
}

export type ExcalidrawFileData = {
  id?: string
  dataURL?: string
  mimeType?: string
  created?: number
  lastRetrieved?: number
  [key: string]: unknown
}

export type ExcalidrawScene = {
  type: 'excalidraw'
  version: 2
  source?: string
  elements: ExcalidrawElementData[]
  appState: Record<string, unknown>
  files: Record<string, ExcalidrawFileData>
  [key: string]: unknown
}

export class SceneParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SceneParseError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertElement = (value: unknown, index: number): ExcalidrawElementData => {
  if (!isRecord(value)) {
    throw new SceneParseError(`Element ${index} must be an object`)
  }

  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new SceneParseError(`Element ${index} has no valid id`)
  }

  if (!Number.isSafeInteger(value.version) || Number(value.version) < 0) {
    throw new SceneParseError(`Element ${value.id} has no valid version`)
  }

  if (!Number.isSafeInteger(value.versionNonce)) {
    throw new SceneParseError(`Element ${value.id} has no valid versionNonce`)
  }

  return value as ExcalidrawElementData
}

export const parseSceneText = (text: string): ExcalidrawScene => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SceneParseError(error instanceof Error ? error.message : 'Invalid JSON', {
      cause: error
    })
  }

  if (!isRecord(parsed)) {
    throw new SceneParseError('The document root must be an object')
  }

  if (parsed.type !== 'excalidraw') {
    throw new SceneParseError('The document type must be "excalidraw"')
  }

  if (parsed.version !== 2) {
    throw new SceneParseError('Only Excalidraw version 2 documents are supported')
  }

  if (!Array.isArray(parsed.elements)) {
    throw new SceneParseError('The document elements must be an array')
  }

  if (!isRecord(parsed.appState)) {
    throw new SceneParseError('The document appState must be an object')
  }

  if (!isRecord(parsed.files)) {
    throw new SceneParseError('The document files must be an object')
  }

  const elements = parsed.elements.map(assertElement)
  const files = Object.fromEntries(
    Object.entries(parsed.files).map(([id, value]) => {
      if (!isRecord(value)) {
        throw new SceneParseError(`Embedded file ${id} must be an object`)
      }
      return [id, value as ExcalidrawFileData]
    })
  )

  return {
    ...parsed,
    type: 'excalidraw',
    version: 2,
    elements,
    appState: parsed.appState,
    files
  }
}

export const serializeScene = (scene: ExcalidrawScene): string =>
  `${JSON.stringify(scene, null, 2)}\n`

export const createEmptyScene = (): ExcalidrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [],
  appState: {
    gridSize: null,
    viewBackgroundColor: '#ffffff'
  },
  files: {}
})

export const cloneScene = (scene: ExcalidrawScene): ExcalidrawScene =>
  structuredClone(scene)
