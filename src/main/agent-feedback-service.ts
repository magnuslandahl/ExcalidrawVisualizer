import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import type { AgentBindingRecord, FeedbackStore } from './feedback-store'
import type {
  AgentConnectionStatus,
  AgentDeliveryAttempt,
  AgentDeliveryMode,
  AgentEvent,
  AgentReadiness
} from '../shared/agent-feedback'
import type { LocalFeedbackSubmission } from '../shared/feedback'

type PairingDescriptor = {
  endpoint: string
  bootstrapToken: string
  generation: string
  expiresAt: string
}

type ActiveConnection = {
  endpoint: URL
  token: string
  generation: string
  sessionId: string
  cursor: number
}

type PairResponse = {
  protocolVersion: number
  connectionToken: string
  connectionGeneration: string
  sessionId: string
  readiness: AgentReadiness
  blockedReason?: unknown
  lastEventSequence: number
}

type BindingResponse = {
  bindingId: string
  generation: string
  createdAt: string
}

type SubmissionResponse = {
  status: 'accepted' | 'rejected'
  messageId?: string
  admittedAt?: string
  error?: string
}

type ProviderEvent = {
  sequence: number
  type: string
  createdAt: string
  data: Record<string, unknown>
}

type EventsResponse = {
  events: ProviderEvent[]
  nextCursor: number
  readiness: AgentReadiness
  blockedReason?: unknown
}

type DispatchInput = {
  storageDocumentId: string
  displayLabel: string
  submission: LocalFeedbackSubmission
  mode: AgentDeliveryMode
  generation: string
}

const MAXIMUM_RESPONSE_BYTES = 1024 * 1024

const disconnectedStatus = (
  detail: string | null = null
): AgentConnectionStatus => ({
  paired: false,
  readiness: 'disconnected',
  sessionId: null,
  generation: null,
  blockedReason: null,
  lastEventSequence: 0,
  detail
})

const describeBlockedReason = (reason: unknown): string | null => {
  if (!reason) {
    return null
  }
  if (typeof reason === 'string') {
    return reason
  }
  if (typeof reason === 'object') {
    try {
      return JSON.stringify(reason)
    } catch {
      return 'The Copilot task is waiting for input'
    }
  }
  return String(reason)
}

const parsePairingCode = (pairingCode: string): PairingDescriptor => {
  let value: unknown
  try {
    value = JSON.parse(
      Buffer.from(pairingCode.slice('evp1:'.length), 'base64url').toString(
        'utf8'
      )
    )
  } catch {
    throw new Error('The pairing code is malformed')
  }
  if (!value || typeof value !== 'object') {
    throw new Error('The pairing code is malformed')
  }
  const candidate = value as Partial<PairingDescriptor>
  if (
    typeof candidate.endpoint !== 'string' ||
    typeof candidate.bootstrapToken !== 'string' ||
    typeof candidate.generation !== 'string' ||
    typeof candidate.expiresAt !== 'string'
  ) {
    throw new Error('The pairing code is incomplete')
  }
  if (new Date(candidate.expiresAt).getTime() <= Date.now()) {
    throw new Error('The pairing code has expired')
  }
  const endpoint = new URL(candidate.endpoint)
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/'
  ) {
    throw new Error('The pairing endpoint is not a valid loopback address')
  }
  if (
    candidate.bootstrapToken.length < 32 ||
    candidate.bootstrapToken.length > 256 ||
    candidate.generation.length < 16 ||
    candidate.generation.length > 128
  ) {
    throw new Error('The pairing capability is invalid')
  }
  return {
    endpoint: endpoint.toString(),
    bootstrapToken: candidate.bootstrapToken,
    generation: candidate.generation,
    expiresAt: candidate.expiresAt
  }
}

const formatPrompt = (
  displayLabel: string,
  submission: LocalFeedbackSubmission
): string => {
  const items = submission.feedback.map((feedback, index) => ({
    number: index + 1,
    target: feedback.target,
    text: feedback.text
  }))
  return [
    `Apply visual feedback to ${displayLabel}.`,
    `The file on disk is the source of truth. Document revision: ${submission.documentRevision}.`,
    'Review each item, make only the requested changes, preserve unrelated content, and report what changed.',
    '',
    JSON.stringify({ submissionId: submission.id, items }, null, 2)
  ].join('\n')
}

export class AgentFeedbackService {
  readonly #store: FeedbackStore
  readonly #onEvent: (event: AgentEvent) => void
  #connection: ActiveConnection | null = null
  #status = disconnectedStatus()
  #pollTimer: ReturnType<typeof setTimeout> | null = null
  #operationQueue = Promise.resolve()

  constructor(store: FeedbackStore, onEvent: (event: AgentEvent) => void) {
    this.#store = store
    this.#onEvent = onEvent
  }

  get status(): AgentConnectionStatus {
    return structuredClone(this.#status)
  }

  pair(pairingCode: string): Promise<AgentConnectionStatus> {
    return this.#serialize(() => this.#pair(pairingCode))
  }

  async #pair(pairingCode: string): Promise<AgentConnectionStatus> {
    const descriptor = parsePairingCode(pairingCode)
    if (descriptor.generation === this.#connection?.generation) {
      return this.status
    }
    await this.#unpair(false)
    const endpoint = new URL(descriptor.endpoint)
    const visualizerNonce = randomBytes(24).toString('base64url')
    const response = await this.#request<PairResponse>(
      endpoint,
      '/v1/pair',
      {
        method: 'POST',
        body: {
          bootstrapToken: descriptor.bootstrapToken,
          visualizerNonce
        }
      },
      null,
      5000
    )
    if (
      response.protocolVersion !== 1 ||
      response.connectionGeneration !== descriptor.generation ||
      typeof response.connectionToken !== 'string' ||
      response.connectionToken.length < 32
    ) {
      throw new Error('The companion returned an incompatible pairing response')
    }
    this.#connection = {
      endpoint,
      token: response.connectionToken,
      generation: response.connectionGeneration,
      sessionId: response.sessionId,
      cursor: response.lastEventSequence
    }
    const pairedAt = new Date().toISOString()
    await this.#store.recordAgentConnection(
      response.connectionGeneration,
      response.sessionId,
      pairedAt
    )
    this.#setStatus({
      paired: true,
      readiness: response.readiness,
      sessionId: response.sessionId,
      generation: response.connectionGeneration,
      blockedReason: describeBlockedReason(response.blockedReason),
      lastEventSequence: response.lastEventSequence,
      detail: null
    })
    this.#schedulePoll(0)
    return this.status
  }

  unpair(notifyProvider = true): Promise<AgentConnectionStatus> {
    return this.#serialize(() => this.#unpair(notifyProvider))
  }

  async #unpair(notifyProvider: boolean): Promise<AgentConnectionStatus> {
    const connection = this.#connection
    this.#connection = null
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
    if (connection) {
      if (notifyProvider) {
        try {
          await this.#request(
            connection.endpoint,
            '/v1/unpair',
            { method: 'POST', body: {} },
            connection.token,
            5000
          )
        } catch {
          // Local retirement is authoritative when the companion is unavailable.
        }
      }
      await this.#store.retireAgentConnection(
        connection.generation,
        new Date().toISOString()
      )
    }
    this.#setStatus(disconnectedStatus())
    return this.status
  }

  preflight(mode: AgentDeliveryMode): Promise<string> {
    return this.#serialize(async () => {
      const connection = this.#connection
      if (!connection) {
        throw new Error(
          'Pair with the intended Copilot task before sending feedback'
        )
      }
      if (
        mode === 'enqueue' &&
        (await this.#store.hasUnresolvedUnknown(connection.generation))
      ) {
        throw new Error(
          'A previous delivery has unknown admission state. Retire it explicitly before queueing more feedback.'
        )
      }
      return connection.generation
    })
  }

  dispatch(input: DispatchInput): Promise<AgentDeliveryAttempt> {
    return this.#serialize(() => this.#dispatch(input))
  }

  retireAttempt(attemptId: string): Promise<AgentDeliveryAttempt> {
    return this.#serialize(() => this.#retireAttempt(attemptId))
  }

  async #retireAttempt(attemptId: string): Promise<AgentDeliveryAttempt> {
    const existing = await this.#store.getAgentAttempt(attemptId)
    if (existing.status !== 'unknown' && existing.status !== 'prepared') {
      throw new Error('Only unresolved delivery attempts can be retired')
    }
    return this.#store.updateAgentAttempt(attemptId, {
      status: 'retired',
      updatedAt: new Date().toISOString(),
      detail: 'Retired explicitly without replay'
    })
  }

  close(): void {
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
    this.#connection = null
  }

  async #dispatch(input: DispatchInput): Promise<AgentDeliveryAttempt> {
    const now = new Date().toISOString()
    let attempt = await this.#store.createAgentAttempt({
      documentId: input.storageDocumentId,
      submissionId: input.submission.id,
      bindingId: null,
      generation: input.generation,
      mode: input.mode,
      status: 'prepared',
      providerMessageId: null,
      reply: null,
      createdAt: now,
      updatedAt: now,
      detail: null
    })
    this.#emitAttempt(attempt)

    const connection = this.#connection
    if (!connection || connection.generation !== input.generation) {
      attempt = await this.#store.updateAgentAttempt(attempt.id, {
        status: 'rejected',
        updatedAt: new Date().toISOString(),
        detail: 'The paired Copilot task changed before dispatch began'
      })
      this.#emitAttempt(attempt)
      return attempt
    }
    if (
      input.mode === 'enqueue' &&
      (await this.#store.hasUnresolvedUnknown(connection.generation))
    ) {
      attempt = await this.#store.updateAgentAttempt(attempt.id, {
        status: 'rejected',
        updatedAt: new Date().toISOString(),
        detail:
          'A previous delivery has unknown admission state. Retire it explicitly before queueing more feedback.'
      })
      this.#emitAttempt(attempt)
      return attempt
    }

    let submissionStarted = false
    try {
      let binding: AgentBindingRecord | null =
        await this.#store.findAgentBinding(
          input.storageDocumentId,
          connection.generation
        )
      if (!binding) {
        const providerBinding = await this.#request<BindingResponse>(
          connection.endpoint,
          '/v1/bindings',
          {
            method: 'POST',
            body: {
              documentId: input.storageDocumentId,
              canonicalPathHash: input.storageDocumentId,
              savedRevision: input.submission.documentRevision,
              requestedCapabilities: ['text-feedback']
            }
          },
          connection.token,
          5000
        )
        if (providerBinding.generation !== connection.generation) {
          throw new Error('The companion binding generation changed during dispatch')
        }
        binding = {
          id: providerBinding.bindingId,
          documentId: input.storageDocumentId,
          generation: providerBinding.generation,
          documentRevision: input.submission.documentRevision,
          createdAt: providerBinding.createdAt,
          retiredAt: null
        }
        await this.#store.saveAgentBinding(binding)
      }
      attempt = await this.#store.updateAgentAttempt(attempt.id, {
        bindingId: binding.id,
        updatedAt: new Date().toISOString()
      })

      submissionStarted = true
      const response = await this.#request<SubmissionResponse>(
        connection.endpoint,
        '/v1/submissions',
        {
          method: 'POST',
          body: {
            attemptId: attempt.id,
            submissionId: input.submission.id,
            bindingId: binding.id,
            bindingGeneration: connection.generation,
            documentRevision: input.submission.documentRevision,
            dispatchRevision: input.submission.documentRevision,
            deliveryIntent: input.mode,
            displayPrompt: `Visualizer feedback: ${input.displayLabel}`.slice(
              0,
              240
            ),
            prompt: formatPrompt(input.displayLabel, input.submission)
          }
        },
        connection.token,
        30_000
      )
      attempt = await this.#store.updateAgentAttempt(attempt.id, {
        status: response.status,
        providerMessageId: response.messageId ?? null,
        updatedAt: response.admittedAt ?? new Date().toISOString(),
        detail: response.error ?? null
      })
    } catch (error) {
      attempt = await this.#store.updateAgentAttempt(attempt.id, {
        status: submissionStarted ? 'unknown' : 'rejected',
        updatedAt: new Date().toISOString(),
        detail:
          error instanceof Error
            ? submissionStarted
              ? `Admission could not be confirmed: ${error.message}`
              : `Delivery was rejected before dispatch: ${error.message}`
            : submissionStarted
              ? 'Admission could not be confirmed'
              : 'Delivery was rejected before dispatch'
      })
    }
    this.#emitAttempt(attempt)
    return attempt
  }

  #schedulePoll(delay: number): void {
    if (!this.#connection) {
      return
    }
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer)
    }
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null
      void this.#poll().finally(() => this.#schedulePoll(1000))
    }, delay)
  }

  async #poll(): Promise<void> {
    const connection = this.#connection
    if (!connection) {
      return
    }
    try {
      const response = await this.#request<EventsResponse>(
        connection.endpoint,
        `/v1/events?cursor=${connection.cursor}&limit=100`,
        { method: 'GET' },
        connection.token,
        5000
      )
      if (this.#connection !== connection) {
        return
      }
      for (const event of response.events) {
        if (event.sequence <= connection.cursor) {
          continue
        }
        await this.#store.recordAgentEvent(
          connection.generation,
          event.sequence,
          event.type,
          event.data,
          event.createdAt
        )
        await this.#applyProviderEvent(event)
        connection.cursor = event.sequence
      }
      connection.cursor = Math.max(connection.cursor, response.nextCursor)
      this.#setStatus({
        ...this.#status,
        paired: true,
        readiness: response.readiness,
        blockedReason: describeBlockedReason(response.blockedReason),
        lastEventSequence: connection.cursor,
        detail: null
      })
    } catch (error) {
      if (this.#connection !== connection) {
        return
      }
      this.#setStatus({
        ...this.#status,
        readiness: 'disconnected',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async #applyProviderEvent(event: ProviderEvent): Promise<void> {
    const attemptId =
      typeof event.data.attemptId === 'string' ? event.data.attemptId : null
    if (!attemptId) {
      return
    }
    let status: AgentDeliveryAttempt['status'] | null = null
    if (event.type === 'submission.consumed') {
      status = 'consumed'
    } else if (event.type === 'submission.reply') {
      status = 'reply-observed'
    } else if (event.type === 'submission.idle') {
      status = 'idle-after-turn'
    }
    if (!status) {
      return
    }
    const update: Parameters<FeedbackStore['updateAgentAttempt']>[1] = {
      status,
      updatedAt: event.createdAt
    }
    if (typeof event.data.messageId === 'string') {
      update.providerMessageId = event.data.messageId
    }
    if (typeof event.data.reply === 'string') {
      update.reply = event.data.reply
    }
    const attempt = await this.#store.updateAgentAttempt(attemptId, update)
    this.#emitAttempt(attempt)
  }

  #emitAttempt(attempt: AgentDeliveryAttempt): void {
    this.#onEvent({
      type: 'attempt',
      documentId: attempt.documentId,
      attempt
    })
  }

  #setStatus(status: AgentConnectionStatus): void {
    this.#status = status
    this.#onEvent({ type: 'connection', connection: this.status })
  }

  async #request<T>(
    endpoint: URL,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
    token: string | null,
    timeout: number
  ): Promise<T> {
    const url = new URL(path, endpoint)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.port !== endpoint.port
    ) {
      throw new Error('The companion request escaped its paired loopback endpoint')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const request: RequestInit = {
        method: options.method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' })
        },
        redirect: 'error',
        signal: controller.signal
      }
      if (options.body !== undefined) {
        request.body = JSON.stringify(options.body)
      }
      const response = await fetch(url, request)
      const reader = response.body?.getReader()
      const chunks: Buffer[] = []
      let totalBytes = 0
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          totalBytes += value.byteLength
          if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
            controller.abort()
            throw new Error('The companion response exceeded 1 MiB')
          }
          chunks.push(Buffer.from(value))
        }
      }
      const text = Buffer.concat(chunks, totalBytes).toString('utf8')
      let payload: unknown
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        throw new Error('The companion returned invalid JSON')
      }
      if (!response.ok) {
        const detail =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof payload.error === 'string'
            ? payload.error
            : `Companion request failed (${response.status})`
        throw new Error(detail)
      }
      return payload as T
    } finally {
      clearTimeout(timer)
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.then(operation, operation)
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
