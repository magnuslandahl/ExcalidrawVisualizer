import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FeedbackStore } from '../src/main/feedback-store'
import {
  FeedbackParseError,
  parseFeedbackTarget,
  type FeedbackTarget,
  type LocalFeedback
} from '../src/shared/feedback'

const testDirectories: string[] = []
const timestamp = (offset: number): string =>
  new Date(Date.UTC(2026, 8, 28, 10, 0, offset)).toISOString()

const draft = (
  id: string,
  documentId: string,
  target: FeedbackTarget = { type: 'drawing' },
  offset = 0
): LocalFeedback => ({
  id,
  documentId,
  createdAt: timestamp(offset),
  updatedAt: timestamp(offset),
  status: 'draft',
  text: `Feedback ${id}`,
  target
})

const arrangeStore = async (): Promise<{ path: string; store: FeedbackStore }> => {
  const directory = join(process.cwd(), 'tests', `.feedback-store-${randomUUID()}`)
  testDirectories.push(directory)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'feedback.json')
  const store = new FeedbackStore(path)
  await store.load()
  return { path, store }
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('FeedbackStore', () => {
  it('persists data and reloads it', async () => {
    const { path, store } = await arrangeStore()
    await store.upsertDraft(draft('feedback-1', 'document-1'))

    const reloaded = new FeedbackStore(path)
    await reloaded.load()

    expect(await reloaded.list('document-1')).toEqual({
      feedback: [draft('feedback-1', 'document-1')],
      submissions: []
    })
  })

  it('serializes concurrent mutations without dropping updates', async () => {
    const { path, store } = await arrangeStore()

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.upsertDraft(draft(`feedback-${index}`, 'document-1', { type: 'drawing' }, index))
      )
    )

    expect((await store.list('document-1')).feedback).toHaveLength(12)
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { feedback: unknown[] }
    expect(persisted.feedback).toHaveLength(12)
  })

  it('accepts all target variants and rejects malformed targets', async () => {
    const { store } = await arrangeStore()
    const targets: FeedbackTarget[] = [
      { type: 'drawing' },
      {
        type: 'elements',
        elementIds: ['rectangle-1', 'text-1'],
        originalBounds: { x: -10, y: 20, width: 300, height: 100 }
      },
      { type: 'point', point: { x: 12.5, y: -8 } },
      { type: 'region', region: { x: 1, y: 2, width: 30, height: 40 } }
    ]

    await Promise.all(
      targets.map((target, index) =>
        store.upsertDraft(draft(`feedback-${index}`, 'document-1', target, index))
      )
    )

    expect((await store.list('document-1')).feedback.map(({ target }) => target)).toEqual(
      targets
    )
    expect(() =>
      parseFeedbackTarget({
        type: 'elements',
        elementIds: [],
        originalBounds: { x: 0, y: 0, width: 10, height: 10 }
      })
    ).toThrow(FeedbackParseError)
  })

  it('keeps immutable feedback snapshots in a submission', async () => {
    const { store } = await arrangeStore()
    await store.upsertDraft(draft('feedback-1', 'document-1'))
    const submission = await store.createSubmission({
      id: 'submission-1',
      documentId: 'document-1',
      feedbackIds: ['feedback-1'],
      documentRevision: 'sha256:revision-1',
      createdAt: timestamp(1)
    })

    submission.feedback[0]!.text = 'caller changed'
    await store.markResolved('document-1', 'feedback-1', timestamp(2))
    const state = await store.list('document-1')

    expect(state.feedback[0]?.status).toBe('resolved')
    expect(state.submissions[0]?.feedback[0]).toMatchObject({
      status: 'submitted-local',
      text: 'Feedback feedback-1'
    })
  })

  it('deletes only the requested document and preserves submission history on item deletion', async () => {
    const { store } = await arrangeStore()
    await store.upsertDraft(draft('feedback-1', 'document-1'))
    await store.upsertDraft(draft('feedback-2', 'document-2'))
    await store.createSubmission({
      id: 'submission-1',
      documentId: 'document-1',
      feedbackIds: ['feedback-1'],
      documentRevision: 'revision-1',
      createdAt: timestamp(1)
    })

    await store.deleteFeedback('document-1', 'feedback-1')
    expect((await store.list('document-1')).submissions).toHaveLength(1)
    await store.deleteDocument('document-1')

    expect(await store.list('document-1')).toEqual({ feedback: [], submissions: [] })
    expect((await store.list('document-2')).feedback).toEqual([
      draft('feedback-2', 'document-2')
    ])
  })

  it('rejects malformed non-missing storage without resetting it', async () => {
    const { path } = await arrangeStore()
    const malformed = '{"schemaVersion":1,"feedback":"corrupt","submissions":[]}'
    await writeFile(path, malformed, 'utf8')
    const store = new FeedbackStore(path)

    await expect(store.load()).rejects.toThrow(FeedbackParseError)
    expect(await readFile(path, 'utf8')).toBe(malformed)
  })

  it('moves untitled feedback to a stable file identity', async () => {
    const { store } = await arrangeStore()
    await store.upsertDraft(draft('feedback-1', 'untitled-document'))
    await store.createSubmission({
      id: 'submission-1',
      documentId: 'untitled-document',
      feedbackIds: ['feedback-1'],
      documentRevision: 'revision-1',
      createdAt: timestamp(1)
    })

    await store.moveDocument('untitled-document', 'path-document')

    expect(await store.list('untitled-document')).toEqual({
      feedback: [],
      submissions: []
    })
    expect(await store.list('path-document')).toMatchObject({
      feedback: [{ documentId: 'path-document' }],
      submissions: [
        {
          documentId: 'path-document',
          feedback: [{ documentId: 'path-document' }]
        }
      ]
    })
  })

  it('isolates internal state from caller mutations', async () => {
    const { store } = await arrangeStore()
    const input = draft('feedback-1', 'document-1', {
      type: 'point',
      point: { x: 1, y: 2 }
    })
    const returned = await store.upsertDraft(input)
    input.text = 'changed input'
    returned.text = 'changed return'
    const firstList = await store.list('document-1')
    firstList.feedback[0]!.text = 'changed list'

    expect((await store.list('document-1')).feedback[0]?.text).toBe(
      'Feedback feedback-1'
    )
  })
})
