import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  parseDocumentId,
  parseFeedbackId,
  parseFeedbackStoreText,
  parseFeedbackTimestamp,
  parseLocalFeedback,
  parseLocalFeedbackSubmission,
  parseLocalFeedbackSubmissionInput,
  type FeedbackDocumentState,
  type LocalFeedback,
  type LocalFeedbackSubmission,
  type LocalFeedbackSubmissionInput
} from '../shared/feedback'
import type {
  AgentAttemptStatus,
  AgentDeliveryAttempt,
  AgentDeliveryMode
} from '../shared/agent-feedback'

export type CreateFeedbackSubmission = LocalFeedbackSubmissionInput

export type AgentBindingRecord = {
  id: string
  documentId: string
  generation: string
  documentRevision: string
  createdAt: string
  retiredAt: string | null
}

const clone = <T>(value: T): T => structuredClone(value)

const parseJson = <T>(value: unknown, label: string): T => {
  if (typeof value !== 'string') {
    throw new Error(`${label} is invalid`)
  }
  return JSON.parse(value) as T
}

export class FeedbackStore {
  readonly #storagePath: string
  readonly #legacyJsonPath: string | undefined
  #database: DatabaseSync | undefined
  #operation = Promise.resolve()

  constructor(storagePath: string, legacyJsonPath?: string) {
    if (storagePath.length === 0) {
      throw new Error('Feedback storage path must not be empty')
    }
    this.#storagePath = storagePath
    this.#legacyJsonPath = legacyJsonPath
  }

  async load(): Promise<void> {
    await this.#serialize(async () => {
      await mkdir(dirname(this.#storagePath), { recursive: true })
      const database = new DatabaseSync(this.#storagePath)
      database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS feedback_document_idx
          ON feedback(document_id, created_at);

        CREATE TABLE IF NOT EXISTS submissions (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS submissions_document_idx
          ON submissions(document_id, created_at);

        CREATE TABLE IF NOT EXISTS agent_connections (
          generation TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          paired_at TEXT NOT NULL,
          retired_at TEXT
        );

        CREATE TABLE IF NOT EXISTS agent_bindings (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          generation TEXT NOT NULL REFERENCES agent_connections(generation),
          document_revision TEXT NOT NULL,
          created_at TEXT NOT NULL,
          retired_at TEXT
        );
        CREATE INDEX IF NOT EXISTS agent_bindings_document_idx
          ON agent_bindings(document_id, generation, retired_at);

        CREATE TABLE IF NOT EXISTS agent_attempts (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          submission_id TEXT NOT NULL REFERENCES submissions(id),
          binding_id TEXT,
          generation TEXT NOT NULL REFERENCES agent_connections(generation),
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_message_id TEXT,
          reply TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS agent_attempts_document_idx
          ON agent_attempts(document_id, created_at);

        CREATE TABLE IF NOT EXISTS agent_events (
          generation TEXT NOT NULL REFERENCES agent_connections(generation),
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (generation, sequence)
        );

        PRAGMA user_version = 2;
      `)
      this.#database = database
      await this.#migrateLegacyJson()
    })
  }

  close(): void {
    this.#database?.close()
    this.#database = undefined
  }

  async list(documentId: string): Promise<FeedbackDocumentState> {
    return this.#serialize(() => {
      const validDocumentId = parseDocumentId(documentId)
      const database = this.#requireDatabase()
      const feedback = database
        .prepare(
          'SELECT payload_json FROM feedback WHERE document_id = ? ORDER BY created_at, id'
        )
        .all(validDocumentId)
        .map((row) => parseLocalFeedback(parseJson(row.payload_json, 'Feedback payload')))
      const submissions = database
        .prepare(
          'SELECT payload_json FROM submissions WHERE document_id = ? ORDER BY created_at, id'
        )
        .all(validDocumentId)
        .map((row) =>
          parseLocalFeedbackSubmission(
            parseJson(row.payload_json, 'Submission payload')
          )
        )
      return clone({ feedback, submissions })
    })
  }

  async upsertDraft(draft: LocalFeedback): Promise<LocalFeedback> {
    return this.#serialize(() =>
      this.#transaction(() => {
        const validDraft = parseLocalFeedback(draft)
        if (validDraft.status !== 'draft') {
          throw new Error('Only draft feedback can be upserted')
        }
        const database = this.#requireDatabase()
        const existingRow = database
          .prepare('SELECT payload_json FROM feedback WHERE id = ?')
          .get(validDraft.id)
        if (existingRow) {
          const existing = parseLocalFeedback(
            parseJson(existingRow.payload_json, 'Feedback payload')
          )
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
        }
        this.#writeFeedback(validDraft)
        return clone(validDraft)
      })
    )
  }

  async deleteFeedback(documentId: string, feedbackId: string): Promise<boolean> {
    return this.#serialize(() => {
      const result = this.#requireDatabase()
        .prepare('DELETE FROM feedback WHERE document_id = ? AND id = ?')
        .run(parseDocumentId(documentId), parseFeedbackId(feedbackId))
      return result.changes > 0
    })
  }

  async createSubmission(
    input: CreateFeedbackSubmission
  ): Promise<LocalFeedbackSubmission> {
    return this.#serialize(() =>
      this.#transaction(() => {
        const validInput = parseLocalFeedbackSubmissionInput(input)
        const database = this.#requireDatabase()
        if (
          database.prepare('SELECT 1 FROM submissions WHERE id = ?').get(validInput.id)
        ) {
          throw new Error(`Feedback submission "${validInput.id}" already exists`)
        }
        const selected = validInput.feedbackIds.map((feedbackId) => {
          const row = database
            .prepare(
              'SELECT payload_json FROM feedback WHERE document_id = ? AND id = ?'
            )
            .get(validInput.documentId, feedbackId)
          if (!row) {
            throw new Error(`Feedback "${feedbackId}" does not exist in the document`)
          }
          const item = parseLocalFeedback(
            parseJson(row.payload_json, 'Feedback payload')
          )
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
          this.#writeFeedback(submitted)
          return clone(submitted)
        })
        const submission = parseLocalFeedbackSubmission({
          ...validInput,
          feedback: snapshots
        })
        database
          .prepare(
            'INSERT INTO submissions (id, document_id, created_at, payload_json) VALUES (?, ?, ?, ?)'
          )
          .run(
            submission.id,
            submission.documentId,
            submission.createdAt,
            JSON.stringify(submission)
          )
        return clone(submission)
      })
    )
  }

  async restoreSubmissionDrafts(
    submissionId: string,
    updatedAt: string
  ): Promise<void> {
    await this.#serialize(() =>
      this.#transaction(() => {
        const validSubmissionId = parseFeedbackId(
          submissionId,
          'Submission ID'
        )
        const validUpdatedAt = parseFeedbackTimestamp(
          updatedAt,
          'Restored updatedAt'
        )
        const database = this.#requireDatabase()
        const submissionRow = database
          .prepare('SELECT payload_json FROM submissions WHERE id = ?')
          .get(validSubmissionId)
        if (!submissionRow) {
          throw new Error(`Feedback submission "${validSubmissionId}" does not exist`)
        }
        const submission = parseLocalFeedbackSubmission(
          parseJson(submissionRow.payload_json, 'Submission payload')
        )
        for (const snapshot of submission.feedback) {
          const row = database
            .prepare(
              'SELECT payload_json FROM feedback WHERE document_id = ? AND id = ?'
            )
            .get(submission.documentId, snapshot.id)
          if (!row) {
            continue
          }
          const current = parseLocalFeedback(
            parseJson(row.payload_json, 'Feedback payload')
          )
          if (
            current.status === 'submitted-local' &&
            current.updatedAt === submission.createdAt
          ) {
            this.#writeFeedback({
              ...current,
              status: 'draft',
              updatedAt: validUpdatedAt
            })
          }
        }
      })
    )
  }

  async markResolved(
    documentId: string,
    feedbackId: string,
    updatedAt: string
  ): Promise<LocalFeedback> {
    return this.#serialize(() =>
      this.#transaction(() => {
        const validDocumentId = parseDocumentId(documentId)
        const validFeedbackId = parseFeedbackId(feedbackId)
        const validUpdatedAt = parseFeedbackTimestamp(updatedAt, 'Resolved updatedAt')
        const row = this.#requireDatabase()
          .prepare(
            'SELECT payload_json FROM feedback WHERE document_id = ? AND id = ?'
          )
          .get(validDocumentId, validFeedbackId)
        if (!row) {
          throw new Error(
            `Feedback "${validFeedbackId}" does not exist in the document`
          )
        }
        const existing = parseLocalFeedback(
          parseJson(row.payload_json, 'Feedback payload')
        )
        if (validUpdatedAt < existing.updatedAt) {
          throw new Error('Resolved updatedAt timestamp cannot move backwards')
        }
        const resolved: LocalFeedback = {
          ...existing,
          status: 'resolved',
          updatedAt: validUpdatedAt
        }
        this.#writeFeedback(resolved)
        return clone(resolved)
      })
    )
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#serialize(() =>
      this.#transaction(() => {
        const validDocumentId = parseDocumentId(documentId)
        const database = this.#requireDatabase()
        database
          .prepare('DELETE FROM agent_attempts WHERE document_id = ?')
          .run(validDocumentId)
        database
          .prepare('DELETE FROM agent_bindings WHERE document_id = ?')
          .run(validDocumentId)
        database
          .prepare('DELETE FROM submissions WHERE document_id = ?')
          .run(validDocumentId)
        database
          .prepare('DELETE FROM feedback WHERE document_id = ?')
          .run(validDocumentId)
      })
    )
  }

  async moveDocument(
    sourceDocumentId: string,
    destinationDocumentId: string
  ): Promise<void> {
    await this.#serialize(() =>
      this.#transaction(() => {
        const source = parseDocumentId(sourceDocumentId)
        const destination = parseDocumentId(destinationDocumentId)
        if (source === destination) {
          return
        }
        const database = this.#requireDatabase()
        const feedbackRows = database
          .prepare('SELECT payload_json FROM feedback WHERE document_id = ?')
          .all(source)
        const submissionRows = database
          .prepare('SELECT payload_json FROM submissions WHERE document_id = ?')
          .all(source)
        for (const row of feedbackRows) {
          const item = parseLocalFeedback(
            parseJson(row.payload_json, 'Feedback payload')
          )
          if (
            database
              .prepare(
                'SELECT 1 FROM feedback WHERE document_id = ? AND id = ?'
              )
              .get(destination, item.id)
          ) {
            throw new Error('Feedback identifiers conflict at the destination')
          }
          this.#writeFeedback({ ...item, documentId: destination })
        }
        for (const row of submissionRows) {
          const submission = parseLocalFeedbackSubmission(
            parseJson(row.payload_json, 'Submission payload')
          )
          if (
            database
              .prepare(
                'SELECT 1 FROM submissions WHERE document_id = ? AND id = ?'
              )
              .get(destination, submission.id)
          ) {
            throw new Error('Feedback identifiers conflict at the destination')
          }
          const moved = {
            ...submission,
            documentId: destination,
            feedback: submission.feedback.map((item) => ({
              ...item,
              documentId: destination
            }))
          }
          database
            .prepare(
              'UPDATE submissions SET document_id = ?, payload_json = ? WHERE id = ?'
            )
            .run(destination, JSON.stringify(moved), submission.id)
        }
        database
          .prepare('UPDATE agent_bindings SET document_id = ? WHERE document_id = ?')
          .run(destination, source)
        database
          .prepare('UPDATE agent_attempts SET document_id = ? WHERE document_id = ?')
          .run(destination, source)
      })
    )
  }

  async recordAgentConnection(
    generation: string,
    sessionId: string,
    pairedAt: string
  ): Promise<void> {
    await this.#serialize(() => {
      this.#requireDatabase()
        .prepare(
          `INSERT INTO agent_connections (generation, session_id, paired_at, retired_at)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT(generation) DO UPDATE SET
             session_id = excluded.session_id,
             paired_at = excluded.paired_at,
             retired_at = NULL`
        )
        .run(generation, sessionId, pairedAt)
    })
  }

  async retireAgentConnection(
    generation: string,
    retiredAt: string
  ): Promise<void> {
    await this.#serialize(() =>
      this.#transaction(() => {
        const database = this.#requireDatabase()
        database
          .prepare(
            'UPDATE agent_connections SET retired_at = ? WHERE generation = ?'
          )
          .run(retiredAt, generation)
        database
          .prepare(
            'UPDATE agent_bindings SET retired_at = ? WHERE generation = ? AND retired_at IS NULL'
          )
          .run(retiredAt, generation)
      })
    )
  }

  async findAgentBinding(
    documentId: string,
    generation: string
  ): Promise<AgentBindingRecord | null> {
    return this.#serialize(() => {
      const row = this.#requireDatabase()
        .prepare(
          `SELECT id, document_id, generation, document_revision, created_at, retired_at
           FROM agent_bindings
           WHERE document_id = ? AND generation = ? AND retired_at IS NULL
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(parseDocumentId(documentId), generation)
      return row ? this.#bindingFromRow(row) : null
    })
  }

  async saveAgentBinding(binding: AgentBindingRecord): Promise<void> {
    await this.#serialize(() => {
      this.#requireDatabase()
        .prepare(
          `INSERT INTO agent_bindings
           (id, document_id, generation, document_revision, created_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          binding.id,
          parseDocumentId(binding.documentId),
          binding.generation,
          binding.documentRevision,
          binding.createdAt,
          binding.retiredAt
        )
    })
  }

  async createAgentAttempt(
    input: Omit<AgentDeliveryAttempt, 'id'>
  ): Promise<AgentDeliveryAttempt> {
    return this.#serialize(() => {
      const attempt: AgentDeliveryAttempt = {
        ...input,
        id: randomUUID()
      }
      this.#writeAttempt(attempt)
      return clone(attempt)
    })
  }

  async updateAgentAttempt(
    attemptId: string,
    update: Partial<
      Pick<
        AgentDeliveryAttempt,
        | 'bindingId'
        | 'status'
        | 'providerMessageId'
        | 'reply'
        | 'updatedAt'
        | 'detail'
      >
    >
  ): Promise<AgentDeliveryAttempt> {
    return this.#serialize(() => {
      const existing = this.#getAttempt(attemptId)
      const updated = { ...existing, ...update }
      this.#writeAttempt(updated)
      return clone(updated)
    })
  }

  async getAgentAttempt(attemptId: string): Promise<AgentDeliveryAttempt> {
    return this.#serialize(() => clone(this.#getAttempt(attemptId)))
  }

  async listAgentAttempts(documentId: string): Promise<AgentDeliveryAttempt[]> {
    return this.#serialize(() =>
      this.#requireDatabase()
        .prepare(
          `SELECT * FROM agent_attempts
           WHERE document_id = ? ORDER BY created_at DESC, id DESC`
        )
        .all(parseDocumentId(documentId))
        .map((row) => this.#attemptFromRow(row))
    )
  }

  async hasUnresolvedUnknown(generation: string): Promise<boolean> {
    return this.#serialize(
      () =>
        Boolean(
          this.#requireDatabase()
            .prepare(
              `SELECT 1 FROM agent_attempts
               WHERE generation = ? AND status = 'unknown' LIMIT 1`
            )
            .get(generation)
        )
    )
  }

  async recordAgentEvent(
    generation: string,
    sequence: number,
    type: string,
    payload: unknown,
    createdAt: string
  ): Promise<boolean> {
    return this.#serialize(() => {
      const result = this.#requireDatabase()
        .prepare(
          `INSERT OR IGNORE INTO agent_events
           (generation, sequence, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(generation, sequence, type, JSON.stringify(payload), createdAt)
      return result.changes > 0
    })
  }

  #writeFeedback(feedback: LocalFeedback): void {
    this.#requireDatabase()
      .prepare(
        `INSERT INTO feedback
         (id, document_id, created_at, updated_at, status, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           document_id = excluded.document_id,
           updated_at = excluded.updated_at,
           status = excluded.status,
           payload_json = excluded.payload_json`
      )
      .run(
        feedback.id,
        feedback.documentId,
        feedback.createdAt,
        feedback.updatedAt,
        feedback.status,
        JSON.stringify(feedback)
      )
  }

  #writeAttempt(attempt: AgentDeliveryAttempt): void {
    this.#requireDatabase()
      .prepare(
        `INSERT INTO agent_attempts
         (id, document_id, submission_id, binding_id, generation, mode, status,
          provider_message_id, reply, created_at, updated_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           binding_id = excluded.binding_id,
           status = excluded.status,
           provider_message_id = excluded.provider_message_id,
           reply = excluded.reply,
           updated_at = excluded.updated_at,
           detail = excluded.detail`
      )
      .run(
        attempt.id,
        attempt.documentId,
        attempt.submissionId,
        attempt.bindingId,
        attempt.generation,
        attempt.mode,
        attempt.status,
        attempt.providerMessageId,
        attempt.reply,
        attempt.createdAt,
        attempt.updatedAt,
        attempt.detail
      )
  }

  #getAttempt(attemptId: string): AgentDeliveryAttempt {
    const row = this.#requireDatabase()
      .prepare('SELECT * FROM agent_attempts WHERE id = ?')
      .get(attemptId)
    if (!row) {
      throw new Error('The feedback delivery attempt was not found')
    }
    return this.#attemptFromRow(row)
  }

  #attemptFromRow(row: Record<string, unknown>): AgentDeliveryAttempt {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      submissionId: String(row.submission_id),
      bindingId: row.binding_id === null ? null : String(row.binding_id),
      generation: String(row.generation),
      mode: String(row.mode) as AgentDeliveryMode,
      status: String(row.status) as AgentAttemptStatus,
      providerMessageId:
        row.provider_message_id === null
          ? null
          : String(row.provider_message_id),
      reply: row.reply === null ? null : String(row.reply),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      detail: row.detail === null ? null : String(row.detail)
    }
  }

  #bindingFromRow(row: Record<string, unknown>): AgentBindingRecord {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      generation: String(row.generation),
      documentRevision: String(row.document_revision),
      createdAt: String(row.created_at),
      retiredAt: row.retired_at === null ? null : String(row.retired_at)
    }
  }

  async #migrateLegacyJson(): Promise<void> {
    if (!this.#legacyJsonPath) {
      return
    }
    const database = this.#requireDatabase()
    const count = database.prepare('SELECT COUNT(*) AS count FROM feedback').get()
    if (Number(count?.count ?? 0) > 0) {
      return
    }
    let text: string
    try {
      text = await readFile(this.#legacyJsonPath, 'utf8')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return
      }
      throw error
    }
    const legacy = parseFeedbackStoreText(text)
    this.#transaction(() => {
      for (const feedback of legacy.feedback) {
        this.#writeFeedback(feedback)
      }
      for (const submission of legacy.submissions) {
        database
          .prepare(
            'INSERT INTO submissions (id, document_id, created_at, payload_json) VALUES (?, ?, ?, ?)'
          )
          .run(
            submission.id,
            submission.documentId,
            submission.createdAt,
            JSON.stringify(submission)
          )
      }
    })
    await rename(
      this.#legacyJsonPath,
      `${this.#legacyJsonPath}.migrated-${Date.now()}`
    )
  }

  #transaction<T>(operation: () => T): T {
    const database = this.#requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  #requireDatabase(): DatabaseSync {
    if (!this.#database) {
      throw new Error('Feedback storage is not initialized')
    }
    return this.#database
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
