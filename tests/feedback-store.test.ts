import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FeedbackStore } from '../src/main/feedback-store'
import {
  FeedbackParseError,
  parseFeedbackInteractionTrace,
  parseFeedbackTarget,
  type FeedbackTarget,
  type LocalFeedback
} from '../src/shared/feedback'

const testDirectories: string[] = []
const stores: FeedbackStore[] = []
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
  const path = join(directory, 'feedback.sqlite')
  const store = new FeedbackStore(path)
  await store.load()
  stores.push(store)
  return { path, store }
}

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close())
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
    stores.push(reloaded)

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
    const database = new DatabaseSync(path)
    const persisted = database.prepare('SELECT COUNT(*) AS count FROM feedback').get()
    database.close()
    expect(persisted?.count).toBe(12)
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

  it('persists bounded ordered interaction traces and accepts older drafts without one', async () => {
    const { store } = await arrangeStore()
    const tracedDraft: LocalFeedback = {
      ...draft('feedback-traced', 'document-1'),
      interactionTrace: [
        {
          type: 'move',
          elapsedMs: 120,
          point: { x: 10, y: 20 },
          elementIds: ['rectangle-1']
        },
        {
          type: 'click',
          elapsedMs: 380,
          point: { x: 30, y: 40 },
          elementIds: ['rectangle-1', 'text-1']
        }
      ]
    }

    await store.upsertDraft(tracedDraft)
    await store.upsertDraft(draft('feedback-legacy', 'document-1', undefined, 1))

    expect((await store.list('document-1')).feedback).toEqual([
      tracedDraft,
      draft('feedback-legacy', 'document-1', undefined, 1)
    ])
    expect(() =>
      parseFeedbackInteractionTrace([
        {
          type: 'click',
          elapsedMs: 200,
          point: { x: 0, y: 0 },
          elementIds: []
        },
        {
          type: 'move',
          elapsedMs: 100,
          point: { x: 1, y: 1 },
          elementIds: []
        }
      ])
    ).toThrow('ordered by elapsed time')
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

  it('restores editable drafts after a rejected delivery without changing the snapshot', async () => {
    const { store } = await arrangeStore()
    await store.upsertDraft(draft('feedback-1', 'document-1'))
    await store.createSubmission({
      id: 'submission-1',
      documentId: 'document-1',
      feedbackIds: ['feedback-1'],
      documentRevision: 'sha256:revision-1',
      createdAt: timestamp(1)
    })

    await store.restoreSubmissionDrafts('submission-1', timestamp(2))
    const state = await store.list('document-1')

    expect(state.feedback[0]).toMatchObject({
      status: 'draft',
      updatedAt: timestamp(2)
    })
    expect(state.submissions[0]?.feedback[0]).toMatchObject({
      status: 'submitted-local',
      updatedAt: timestamp(1)
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
    const directory = join(process.cwd(), 'tests', `.feedback-store-${randomUUID()}`)
    testDirectories.push(directory)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'feedback.sqlite')
    const legacyPath = join(directory, 'feedback.json')
    const malformed = '{"schemaVersion":1,"feedback":"corrupt","submissions":[]}'
    await writeFile(legacyPath, malformed, 'utf8')
    const store = new FeedbackStore(path, legacyPath)
    stores.push(store)

    await expect(store.load()).rejects.toThrow(FeedbackParseError)
    expect(await readFile(legacyPath, 'utf8')).toBe(malformed)
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

  it('migrates the legacy JSON store into SQLite once', async () => {
    const directory = join(process.cwd(), 'tests', `.feedback-store-${randomUUID()}`)
    testDirectories.push(directory)
    await mkdir(directory, { recursive: true })
    const databasePath = join(directory, 'feedback.sqlite')
    const legacyPath = join(directory, 'feedback.json')
    const item = draft('feedback-1', 'document-1')
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        schemaVersion: 1,
        feedback: [item],
        submissions: []
      })}\n`,
      'utf8'
    )
    const store = new FeedbackStore(databasePath, legacyPath)
    stores.push(store)

    await store.load()

    expect((await store.list('document-1')).feedback).toEqual([item])
    await expect(readFile(legacyPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('persists generation-scoped bindings and honest delivery states', async () => {
    const { store } = await arrangeStore()
    await store.upsertDraft(draft('feedback-1', 'document-1'))
    await store.createSubmission({
      id: 'submission-1',
      documentId: 'document-1',
      feedbackIds: ['feedback-1'],
      documentRevision: 'revision-1',
      createdAt: timestamp(1)
    })
    await store.recordAgentConnection('generation-1', 'session-1', timestamp(1))
    await store.saveAgentBinding({
      id: 'binding-1',
      documentId: 'document-1',
      generation: 'generation-1',
      documentRevision: 'revision-1',
      createdAt: timestamp(1),
      retiredAt: null
    })
    const attempt = await store.createAgentAttempt({
      documentId: 'document-1',
      submissionId: 'submission-1',
      bindingId: 'binding-1',
      generation: 'generation-1',
      mode: 'enqueue',
      status: 'prepared',
      providerMessageId: null,
      reply: null,
      createdAt: timestamp(1),
      updatedAt: timestamp(1),
      detail: null
    })

    await store.updateAgentAttempt(attempt.id, {
      status: 'unknown',
      updatedAt: timestamp(2),
      detail: 'Admission timed out'
    })

    expect(await store.hasUnresolvedUnknown('generation-1')).toBe(true)
    expect(await store.findAgentBinding('document-1', 'generation-1')).toMatchObject({
      id: 'binding-1',
      retiredAt: null
    })
    expect(await store.listAgentAttempts('document-1')).toMatchObject([
      { id: attempt.id, status: 'unknown', detail: 'Admission timed out' }
    ])
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
