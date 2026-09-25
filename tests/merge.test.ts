import { describe, expect, it } from 'vitest'
import { mergeScenes } from '../src/shared/merge'
import { element, scene } from './fixtures'

describe('mergeScenes', () => {
  it('merges non-overlapping element changes', () => {
    const base = scene([element('left'), element('right')])
    const local = scene([
      element('left', 2, { x: 80, versionNonce: 201 }),
      element('right')
    ])
    const external = scene([
      element('left'),
      element('right', 2, { y: 120, versionNonce: 202 })
    ])

    const result = mergeScenes(base, local, external)

    expect(result.kind).toBe('merged')
    if (result.kind === 'merged') {
      expect(result.scene.elements.find(({ id }) => id === 'left')?.x).toBe(80)
      expect(result.scene.elements.find(({ id }) => id === 'right')?.y).toBe(120)
    }
  })

  it('detects incompatible changes to the same element', () => {
    const base = scene([element('shared')])
    const local = scene([element('shared', 2, { x: 40, versionNonce: 201 })])
    const external = scene([element('shared', 2, { y: 60, versionNonce: 202 })])

    const result = mergeScenes(base, local, external)

    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.conflict.elementIds).toEqual(['shared'])
    }
  })

  it('detects local deletion versus external modification', () => {
    const base = scene([element('shared')])
    const local = scene([])
    const external = scene([element('shared', 2, { x: 20, versionNonce: 201 })])

    const result = mergeScenes(base, local, external)

    expect(result.kind).toBe('conflict')
  })

  it('detects external deletion versus local modification', () => {
    const base = scene([element('shared')])
    const local = scene([element('shared', 2, { x: 20, versionNonce: 201 })])
    const external = scene([])

    const result = mergeScenes(base, local, external)

    expect(result.kind).toBe('conflict')
  })

  it('merges additions to the embedded files map', () => {
    const base = scene()
    const local = scene([], {
      files: {
        localFile: {
          id: 'localFile',
          dataURL: 'data:image/png;base64,bG9jYWw=',
          mimeType: 'image/png',
          created: 1
        }
      }
    })
    const external = scene([], {
      files: {
        externalFile: {
          id: 'externalFile',
          dataURL: 'data:image/png;base64,ZXh0ZXJuYWw=',
          mimeType: 'image/png',
          created: 2
        }
      }
    })

    const result = mergeScenes(base, local, external)

    expect(result.kind).toBe('merged')
    if (result.kind === 'merged') {
      expect(Object.keys(result.scene.files).sort()).toEqual(['externalFile', 'localFile'])
    }
  })

  it('preserves a dirty local document when the external edit is unrelated', () => {
    const base = scene([element('manual'), element('agent')])
    const dirtyLocal = scene([
      element('manual', 2, { x: 90, versionNonce: 201 }),
      element('agent')
    ])
    const external = scene([
      element('manual'),
      element('agent', 2, { backgroundColor: '#a5d8ff', versionNonce: 202 })
    ])

    const result = mergeScenes(base, dirtyLocal, external)

    expect(result.kind).toBe('merged')
    if (result.kind === 'merged') {
      expect(result.scene.elements.find(({ id }) => id === 'manual')?.x).toBe(90)
      expect(
        result.scene.elements.find(({ id }) => id === 'agent')?.backgroundColor
      ).toBe('#a5d8ff')
    }
  })
})
