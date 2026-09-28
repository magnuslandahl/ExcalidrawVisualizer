import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import {
  FEEDBACK_STORE_SCHEMA_VERSION,
  parseDocumentId,
  parseFeedbackId,
  parseFeedbackStoreText,
  parseFeedbackTimestamp,
  parseLocalFeedback,
  parseLocalFeedbackSubmissionInput,
  serializeFeedbackStore,
  type FeedbackStoreData,
  type FeedbackDocumentState,
  type LocalFeedback,
  type LocalFeedbackSubmission,
  type LocalFeedbackSubmissionInput
} from '../shared/feedback'

export type CreateFeedbackSubmission = LocalFeedbackSubmissionInput

const emptyStore = (): FeedbackStoreData => ({
  schemaVersion: FEEDBACK_STORE_SCHEMA_VERSION,
  feedback: [],
  submissions: []
})

const clone = <T>(value: T): T => structuredClone(value)

export class FeedbackStore {
  readonly #storagePath: string
  #data = emptyStore()
  #operation = Promise.resolve()

  constructor(storagePath: string) {
    if (storagePath.length === 0) {
      throw new Error('Feedback storage path must not be empty')
    }
    this.#storagePath = storagePath
  }

  async load(): Promise<void> {
    await this.#serialize(async () => {
      try {
        this.#data = parseFeedbackStoreText(await readFile(this.#storagePath, 'utf8'))
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code === 'ENOENT') {
          this.#data = emptyStore()
          return
        }
        throw error
      }
    })
  }

  async list(documentId: string): Promise<FeedbackDocumentState> {
    return this.#serialize(() => {
      const validDocumentId = parseDocumentId(documentId)
      return clone({
        feedback: this.#data.feedback.filter((item) => item.documentId === validDocumentId),
        submissions: this.#data.submissions.filter(
          (item) => item.documentId === validDocumentId
        )
      })
    })
  }

  async upsertDraft(draft: LocalFeedback): Promise<LocalFeedback> {
    return this.#mutate((data) => {
      const validDraft = parseLocalFeedback(draft)
      if (validDraft.status !== 'draft') {
        throw new Error('Only draft feedback can be upserted')
      }

      const existingIndex = data.feedback.findIndex(({ id }) => id === validDraft.id)
      const existing = data.feedback[existingIndex]
      if (existing !== undefined) {
        if (existing.documentId !== validDraft.documentId) {
          throw new Error('A feedback id cannot be moved to another document')
        }
        if (existing.status !== 'draft') {
          throw new Error('Submitted or resolved feedback cannot be replaced as a draft')
        }
        if (existing.createdAt !== validDraft.createdAt) {
          throw new Error('A feedback draft createdAt timestamp is immutable')
        }
        if (validDraft.updatedAt < existing.updatedAt) {
          throw new Error('A feedback draft updatedAt timestamp cannot move backwards')
        }
        data.feedback[existingIndex] = validDraft
      } else {
        data.feedback.push(validDraft)
      }
      return validDraft
    })
  }

  async deleteFeedback(documentId: string, feedbackId: string): Promise<boolean> {
    return this.#mutate((data) => {
      const validDocumentId = parseDocumentId(documentId)
      const validFeedbackId = parseFeedbackId(feedbackId)
      const index = data.feedback.findIndex(
        (item) => item.documentId === validDocumentId && item.id === validFeedbackId
      )
      if (index < 0) {
        return false
      }
      data.feedback.splice(index, 1)
      return true
    })
  }

  async createSubmission(input: CreateFeedbackSubmission): Promise<LocalFeedbackSubmission> {
    return this.#mutate((data) => {
      const validInput = parseLocalFeedbackSubmissionInput(input)
      if (data.submissions.some(({ id }) => id === validInput.id)) {
        throw new Error(`Feedback submission "${validInput.id}" already exists`)
      }

      const selected = validInput.feedbackIds.map((feedbackId) => {
        const item = data.feedback.find(
          (candidate) =>
            candidate.documentId === validInput.documentId && candidate.id === feedbackId
        )
        if (item === undefined) {
          throw new Error(`Feedback "${feedbackId}" does not exist in the document`)
        }
        if (item.status !== 'draft') {
          throw new Error(`Feedback "${feedbackId}" is not a draft`)
        }
        if (validInput.createdAt < item.updatedAt) {
          throw new Error('Submission createdAt must not precede its feedback')
        }
        return item
      })

      const snapshots = selected.map((item) => {
        const submitted: LocalFeedback = {
          ...item,
          status: 'submitted-local',
          updatedAt: validInput.createdAt
        }
        const index = data.feedback.findIndex(({ id }) => id === item.id)
        data.feedback[index] = submitted
        return clone(submitted)
      })
      const submission: LocalFeedbackSubmission = {
        ...validInput,
        feedback: snapshots
      }
      data.submissions.push(submission)
      return submission
    })
  }

  async markResolved(
    documentId: string,
    feedbackId: string,
    updatedAt: string
  ): Promise<LocalFeedback> {
    return this.#mutate((data) => {
      const validDocumentId = parseDocumentId(documentId)
      const validFeedbackId = parseFeedbackId(feedbackId)
      const validUpdatedAt = parseFeedbackTimestamp(updatedAt, 'Resolved updatedAt')
      const index = data.feedback.findIndex(
        (item) => item.documentId === validDocumentId && item.id === validFeedbackId
      )
      const existing = data.feedback[index]
      if (existing === undefined) {
        throw new Error(`Feedback "${validFeedbackId}" does not exist in the document`)
      }
      if (validUpdatedAt < existing.updatedAt) {
        throw new Error('Resolved updatedAt timestamp cannot move backwards')
      }
      const resolved: LocalFeedback = {
        ...existing,
        status: 'resolved',
        updatedAt: validUpdatedAt
      }
      data.feedback[index] = resolved
      return resolved
    })
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#mutate((data) => {
      const validDocumentId = parseDocumentId(documentId)
      data.feedback = data.feedback.filter((item) => item.documentId !== validDocumentId)
      data.submissions = data.submissions.filter(
        (item) => item.documentId !== validDocumentId
      )
    })
  }

  async moveDocument(sourceDocumentId: string, destinationDocumentId: string): Promise<void> {
    await this.#mutate((data) => {
      const source = parseDocumentId(sourceDocumentId)
      const destination = parseDocumentId(destinationDocumentId)
      if (source === destination) {
        return
      }
      const movingFeedbackIds = new Set(
        data.feedback
          .filter((item) => item.documentId === source)
          .map((item) => item.id)
      )
      const movingSubmissionIds = new Set(
        data.submissions
          .filter((item) => item.documentId === source)
          .map((item) => item.id)
      )
      if (
        data.feedback.some(
          (item) =>
            item.documentId === destination && movingFeedbackIds.has(item.id)
        ) ||
        data.submissions.some(
          (item) =>
            item.documentId === destination && movingSubmissionIds.has(item.id)
        )
      ) {
        throw new Error('Feedback identifiers conflict at the destination')
      }
      data.feedback = data.feedback.map((item) =>
        item.documentId === source ? { ...item, documentId: destination } : item
      )
      data.submissions = data.submissions.map((submission) =>
        submission.documentId === source
          ? {
              ...submission,
              documentId: destination,
              feedback: submission.feedback.map((item) => ({
                ...item,
                documentId: destination
              }))
            }
          : submission
      )
    })
  }

  async #mutate<T>(mutation: (data: FeedbackStoreData) => T): Promise<T> {
    return this.#serialize(async () => {
      const candidate = clone(this.#data)
      const result = mutation(candidate)
      await mkdir(dirname(this.#storagePath), { recursive: true })
      await atomicWriteFile(this.#storagePath, serializeFeedbackStore(candidate))
      this.#data = candidate
      return clone(result)
    })
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation)
    this.#operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
