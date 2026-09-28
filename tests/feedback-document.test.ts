import { describe, expect, it } from 'vitest'
import { feedbackDocumentStorageKey } from '../src/main/feedback-document'

describe('feedback document storage identity', () => {
  it('is stable across file-backed document IDs and hides the source path', () => {
    const first = feedbackDocumentStorageKey({
      id: 'session-document-1',
      path: '/drawings/architecture.excalidraw'
    })
    const reopened = feedbackDocumentStorageKey({
      id: 'session-document-2',
      path: '/drawings/architecture.excalidraw'
    })

    expect(reopened).toBe(first)
    expect(first).not.toContain('/drawings')
  })

  it('case-folds Windows paths and keeps untitled documents isolated', () => {
    expect(
      feedbackDocumentStorageKey(
        { id: 'first', path: 'C:\\Drawings\\System.excalidraw' },
        'win32'
      )
    ).toBe(
      feedbackDocumentStorageKey(
        { id: 'second', path: 'c:\\drawings\\system.excalidraw' },
        'win32'
      )
    )
    expect(feedbackDocumentStorageKey({ id: 'first', path: null })).not.toBe(
      feedbackDocumentStorageKey({ id: 'second', path: null })
    )
  })
})
