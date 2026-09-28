export const FEEDBACK_STORE_SCHEMA_VERSION = 1 as const
export const MAX_FEEDBACK_TEXT_LENGTH = 10_000

const MAX_ID_LENGTH = 256
const MAX_REVISION_LENGTH = 1_024

export type FeedbackStatus = 'draft' | 'submitted-local' | 'resolved'

export type FeedbackPoint = {
  x: number
  y: number
}

export type FeedbackBounds = FeedbackPoint & {
  width: number
  height: number
}

export type DrawingFeedbackTarget = {
  type: 'drawing'
}

export type ElementsFeedbackTarget = {
  type: 'elements'
  elementIds: string[]
  originalBounds: FeedbackBounds
}

export type PointFeedbackTarget = {
  type: 'point'
  point: FeedbackPoint
}

export type RegionFeedbackTarget = {
  type: 'region'
  region: FeedbackBounds
}

export type FeedbackTarget =
  | DrawingFeedbackTarget
  | ElementsFeedbackTarget
  | PointFeedbackTarget
  | RegionFeedbackTarget

export type LocalFeedback = {
  id: string
  documentId: string
  createdAt: string
  updatedAt: string
  status: FeedbackStatus
  text: string
  target: FeedbackTarget
}

export type LocalFeedbackSubmission = {
  id: string
  documentId: string
  feedbackIds: string[]
  documentRevision: string
  createdAt: string
  feedback: LocalFeedback[]
}

export type LocalFeedbackSubmissionInput = Omit<LocalFeedbackSubmission, 'feedback'>

export type FeedbackStoreData = {
  schemaVersion: typeof FEEDBACK_STORE_SCHEMA_VERSION
  feedback: LocalFeedback[]
  submissions: LocalFeedbackSubmission[]
}

export type FeedbackDocumentState = {
  feedback: LocalFeedback[]
  submissions: LocalFeedbackSubmission[]
}

export class FeedbackParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FeedbackParseError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void => {
  const expected = new Set(expectedKeys)
  const unexpected = Object.keys(value).find((key) => !expected.has(key))
  const missing = expectedKeys.find((key) => !(key in value))
  if (unexpected !== undefined) {
    throw new FeedbackParseError(`${label} has unexpected property "${unexpected}"`)
  }
  if (missing !== undefined) {
    throw new FeedbackParseError(`${label} is missing property "${missing}"`)
  }
}

const parseBoundedString = (
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false
): string => {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength
  ) {
    throw new FeedbackParseError(
      `${label} must be ${allowEmpty ? '' : 'a non-empty '}string of at most ${maximumLength} characters`
    )
  }
  return value
}

export const parseFeedbackId = (value: unknown, label = 'Feedback id'): string =>
  parseBoundedString(value, label, MAX_ID_LENGTH)

export const parseDocumentId = (value: unknown): string =>
  parseBoundedString(value, 'Document id', MAX_ID_LENGTH)

export const parseFeedbackTimestamp = (value: unknown, label = 'Timestamp'): string => {
  const timestamp = parseBoundedString(value, label, 64)
  let canonical: string
  try {
    canonical = new Date(timestamp).toISOString()
  } catch {
    throw new FeedbackParseError(`${label} must be a valid ISO 8601 timestamp`)
  }
  if (canonical !== timestamp) {
    throw new FeedbackParseError(`${label} must be a canonical ISO 8601 timestamp`)
  }
  return timestamp
}

export const parseFeedbackText = (value: unknown): string =>
  parseBoundedString(value, 'Feedback text', MAX_FEEDBACK_TEXT_LENGTH, true)

const parseFiniteNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FeedbackParseError(`${label} must be a finite number`)
  }
  return value
}

const parsePoint = (value: unknown, label: string): FeedbackPoint => {
  if (!isRecord(value)) {
    throw new FeedbackParseError(`${label} must be an object`)
  }
  assertExactKeys(value, ['x', 'y'], label)
  return {
    x: parseFiniteNumber(value.x, `${label}.x`),
    y: parseFiniteNumber(value.y, `${label}.y`)
  }
}

const parseBounds = (value: unknown, label: string): FeedbackBounds => {
  if (!isRecord(value)) {
    throw new FeedbackParseError(`${label} must be an object`)
  }
  assertExactKeys(value, ['x', 'y', 'width', 'height'], label)
  const width = parseFiniteNumber(value.width, `${label}.width`)
  const height = parseFiniteNumber(value.height, `${label}.height`)
  if (width < 0 || height < 0) {
    throw new FeedbackParseError(`${label} dimensions must not be negative`)
  }
  return {
    x: parseFiniteNumber(value.x, `${label}.x`),
    y: parseFiniteNumber(value.y, `${label}.y`),
    width,
    height
  }
}

export const parseFeedbackTarget = (value: unknown): FeedbackTarget => {
  if (!isRecord(value)) {
    throw new FeedbackParseError('Feedback target must be an object')
  }

  switch (value.type) {
    case 'drawing':
      assertExactKeys(value, ['type'], 'Drawing target')
      return { type: 'drawing' }
    case 'elements': {
      assertExactKeys(value, ['type', 'elementIds', 'originalBounds'], 'Elements target')
      if (!Array.isArray(value.elementIds) || value.elementIds.length === 0) {
        throw new FeedbackParseError('Elements target must contain at least one element id')
      }
      const elementIds = value.elementIds.map((id, index) =>
        parseFeedbackId(id, `Element id ${index}`)
      )
      if (new Set(elementIds).size !== elementIds.length) {
        throw new FeedbackParseError('Elements target element ids must be unique')
      }
      return {
        type: 'elements',
        elementIds,
        originalBounds: parseBounds(value.originalBounds, 'Elements target original bounds')
      }
    }
    case 'point':
      assertExactKeys(value, ['type', 'point'], 'Point target')
      return { type: 'point', point: parsePoint(value.point, 'Point target point') }
    case 'region':
      assertExactKeys(value, ['type', 'region'], 'Region target')
      return { type: 'region', region: parseBounds(value.region, 'Region target region') }
    default:
      throw new FeedbackParseError('Feedback target type is invalid')
  }
}

export const parseLocalFeedback = (value: unknown): LocalFeedback => {
  if (!isRecord(value)) {
    throw new FeedbackParseError('Feedback must be an object')
  }
  assertExactKeys(
    value,
    ['id', 'documentId', 'createdAt', 'updatedAt', 'status', 'text', 'target'],
    'Feedback'
  )

  if (
    value.status !== 'draft' &&
    value.status !== 'submitted-local' &&
    value.status !== 'resolved'
  ) {
    throw new FeedbackParseError('Feedback status is invalid')
  }

  const createdAt = parseFeedbackTimestamp(value.createdAt, 'Feedback createdAt')
  const updatedAt = parseFeedbackTimestamp(value.updatedAt, 'Feedback updatedAt')
  if (updatedAt < createdAt) {
    throw new FeedbackParseError('Feedback updatedAt must not precede createdAt')
  }

  return {
    id: parseFeedbackId(value.id),
    documentId: parseDocumentId(value.documentId),
    createdAt,
    updatedAt,
    status: value.status,
    text: parseFeedbackText(value.text),
    target: parseFeedbackTarget(value.target)
  }
}

export const parseLocalFeedbackSubmission = (value: unknown): LocalFeedbackSubmission => {
  if (!isRecord(value)) {
    throw new FeedbackParseError('Feedback submission must be an object')
  }
  assertExactKeys(
    value,
    ['id', 'documentId', 'feedbackIds', 'documentRevision', 'createdAt', 'feedback'],
    'Feedback submission'
  )
  const input = parseSubmissionFields(value)
  if (!Array.isArray(value.feedback) || value.feedback.length !== input.feedbackIds.length) {
    throw new FeedbackParseError('Feedback submission snapshots must match its feedback ids')
  }

  const feedback = value.feedback.map(parseLocalFeedback)
  feedback.forEach((item, index) => {
    if (item.id !== input.feedbackIds[index]) {
      throw new FeedbackParseError('Submission snapshot order must match its feedback ids')
    }
    if (item.documentId !== input.documentId) {
      throw new FeedbackParseError('Submission snapshots must belong to its document')
    }
    if (item.status !== 'submitted-local') {
      throw new FeedbackParseError('Submission snapshots must have submitted-local status')
    }
    if (item.updatedAt !== input.createdAt) {
      throw new FeedbackParseError('Submission snapshot updatedAt must match its createdAt')
    }
  })

  return {
    ...input,
    feedback
  }
}

const parseSubmissionFields = (
  value: Record<string, unknown>
): LocalFeedbackSubmissionInput => {
  if (!Array.isArray(value.feedbackIds) || value.feedbackIds.length === 0) {
    throw new FeedbackParseError('Feedback submission must contain at least one feedback id')
  }
  const feedbackIds = value.feedbackIds.map((id, index) =>
    parseFeedbackId(id, `Submission feedback id ${index}`)
  )
  if (new Set(feedbackIds).size !== feedbackIds.length) {
    throw new FeedbackParseError('Submission feedback ids must be unique')
  }
  return {
    id: parseFeedbackId(value.id, 'Submission id'),
    documentId: parseDocumentId(value.documentId),
    feedbackIds,
    documentRevision: parseBoundedString(
      value.documentRevision,
      'Submission document revision',
      MAX_REVISION_LENGTH
    ),
    createdAt: parseFeedbackTimestamp(value.createdAt, 'Submission createdAt')
  }
}

export const parseLocalFeedbackSubmissionInput = (
  value: unknown
): LocalFeedbackSubmissionInput => {
  if (!isRecord(value)) {
    throw new FeedbackParseError('Feedback submission input must be an object')
  }
  assertExactKeys(
    value,
    ['id', 'documentId', 'feedbackIds', 'documentRevision', 'createdAt'],
    'Feedback submission input'
  )
  return parseSubmissionFields(value)
}

export const parseFeedbackStoreData = (value: unknown): FeedbackStoreData => {
  if (!isRecord(value)) {
    throw new FeedbackParseError('Feedback store root must be an object')
  }
  assertExactKeys(value, ['schemaVersion', 'feedback', 'submissions'], 'Feedback store')
  if (value.schemaVersion !== FEEDBACK_STORE_SCHEMA_VERSION) {
    throw new FeedbackParseError('Feedback store schema version is unsupported')
  }
  if (!Array.isArray(value.feedback) || !Array.isArray(value.submissions)) {
    throw new FeedbackParseError('Feedback store collections must be arrays')
  }

  const feedback = value.feedback.map(parseLocalFeedback)
  const submissions = value.submissions.map(parseLocalFeedbackSubmission)
  if (new Set(feedback.map(({ id }) => id)).size !== feedback.length) {
    throw new FeedbackParseError('Feedback ids must be unique')
  }
  if (new Set(submissions.map(({ id }) => id)).size !== submissions.length) {
    throw new FeedbackParseError('Feedback submission ids must be unique')
  }

  return {
    schemaVersion: FEEDBACK_STORE_SCHEMA_VERSION,
    feedback,
    submissions
  }
}

export const parseFeedbackStoreText = (text: string): FeedbackStoreData => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new FeedbackParseError(error instanceof Error ? error.message : 'Invalid JSON', {
      cause: error
    })
  }
  return parseFeedbackStoreData(parsed)
}

export const serializeFeedbackStore = (data: FeedbackStoreData): string =>
  `${JSON.stringify(parseFeedbackStoreData(data), null, 2)}\n`
