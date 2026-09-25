import type {
  ExcalidrawElementData,
  ExcalidrawFileData,
  ExcalidrawScene
} from './scene'

export type MergeConflict = {
  elementIds: string[]
  fileIds: string[]
}

export type MergeResult =
  | {
      kind: 'merged'
      scene: ExcalidrawScene
    }
  | {
      kind: 'conflict'
      conflict: MergeConflict
      mergedPreview: ExcalidrawScene
    }

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    )
  }
  return value
}

export const valuesEquivalent = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))

export const scenesEquivalent = (
  left: ExcalidrawScene,
  right: ExcalidrawScene
): boolean => valuesEquivalent(left, right)

const changedFromBase = <T>(base: T | undefined, candidate: T | undefined): boolean =>
  !valuesEquivalent(base, candidate)

type MergeValueResult<T> =
  | { kind: 'value'; value: T | undefined }
  | { kind: 'conflict'; fallback: T | undefined }

const mergeValue = <T>(
  base: T | undefined,
  local: T | undefined,
  external: T | undefined
): MergeValueResult<T> => {
  const localChanged = changedFromBase(base, local)
  const externalChanged = changedFromBase(base, external)

  if (!localChanged) {
    return { kind: 'value', value: external }
  }
  if (!externalChanged || valuesEquivalent(local, external)) {
    return { kind: 'value', value: local }
  }
  return { kind: 'conflict', fallback: local }
}

const orderedIds = (
  base: readonly ExcalidrawElementData[],
  local: readonly ExcalidrawElementData[],
  external: readonly ExcalidrawElementData[]
): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const element of [...base, ...local, ...external]) {
    if (!seen.has(element.id)) {
      seen.add(element.id)
      result.push(element.id)
    }
  }
  return result
}

const toMap = <T extends { id: string }>(values: readonly T[]): Map<string, T> =>
  new Map(values.map((value) => [value.id, value]))

const mergeFiles = (
  base: Record<string, ExcalidrawFileData>,
  local: Record<string, ExcalidrawFileData>,
  external: Record<string, ExcalidrawFileData>
): { files: Record<string, ExcalidrawFileData>; conflicts: string[] } => {
  const ids = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(external)])
  const files: Record<string, ExcalidrawFileData> = {}
  const conflicts: string[] = []

  for (const id of ids) {
    const result = mergeValue(base[id], local[id], external[id])
    if (result.kind === 'conflict') {
      conflicts.push(id)
      if (result.fallback !== undefined) {
        files[id] = result.fallback
      }
    } else if (result.value !== undefined) {
      files[id] = result.value
    }
  }

  return { files, conflicts }
}

export const mergeScenes = (
  base: ExcalidrawScene,
  local: ExcalidrawScene,
  external: ExcalidrawScene
): MergeResult => {
  const baseElements = toMap(base.elements)
  const localElements = toMap(local.elements)
  const externalElements = toMap(external.elements)
  const elementIds = orderedIds(base.elements, local.elements, external.elements)
  const elements: ExcalidrawElementData[] = []
  const elementConflicts: string[] = []

  for (const id of elementIds) {
    const result = mergeValue(
      baseElements.get(id),
      localElements.get(id),
      externalElements.get(id)
    )
    if (result.kind === 'conflict') {
      elementConflicts.push(id)
      if (result.fallback !== undefined) {
        elements.push(result.fallback)
      }
    } else if (result.value !== undefined) {
      elements.push(result.value)
    }
  }

  const fileMerge = mergeFiles(base.files, local.files, external.files)
  const merged: ExcalidrawScene = {
    ...external,
    elements,
    appState: local.appState,
    files: fileMerge.files
  }

  if (elementConflicts.length > 0 || fileMerge.conflicts.length > 0) {
    return {
      kind: 'conflict',
      conflict: {
        elementIds: elementConflicts,
        fileIds: fileMerge.conflicts
      },
      mergedPreview: merged
    }
  }

  return { kind: 'merged', scene: merged }
}
