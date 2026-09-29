import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentFeedbackService } from '../src/main/agent-feedback-service'
import { FeedbackStore } from '../src/main/feedback-store'
import type { AgentEvent } from '../src/shared/agent-feedback'
import type { LocalFeedbackSubmission } from '../src/shared/feedback'

const directories: string[] = []
const stores: FeedbackStore[] = []
const services: AgentFeedbackService[] = []
const servers: ReturnType<typeof createServer>[] = []

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown
): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for agent feedback event')
}

const pairingCode = (
  port: number,
  bootstrapToken: string,
  generation: string
): string =>
  `evp1:${Buffer.from(
    JSON.stringify({
      endpoint: `http://127.0.0.1:${port}/`,
      bootstrapToken,
      generation,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
  ).toString('base64url')}`

const arrangeStore = async (): Promise<{
  store: FeedbackStore
  submission: LocalFeedbackSubmission
}> => {
  const directory = join(process.cwd(), 'tests', `.agent-service-${randomUUID()}`)
  directories.push(directory)
  await mkdir(directory, { recursive: true })
  const store = new FeedbackStore(join(directory, 'feedback.sqlite'))
  stores.push(store)
  await store.load()
  const createdAt = new Date().toISOString()
  await store.upsertDraft({
    id: 'feedback-1',
    documentId: 'document-storage-key',
    createdAt,
    updatedAt: createdAt,
    status: 'draft',
    text: 'Move the title to the left.',
    target: { type: 'drawing' },
    interactionTrace: [
      {
        type: 'move',
        elapsedMs: 150,
        point: { x: 20, y: 30 },
        elementIds: ['title-element']
      },
      {
        type: 'click',
        elapsedMs: 420,
        point: { x: 24, y: 34 },
        elementIds: ['title-element']
      }
    ]
  })
  const submission = await store.createSubmission({
    id: 'submission-1',
    documentId: 'document-storage-key',
    feedbackIds: ['feedback-1'],
    documentRevision: 'sha256:revision-1',
    createdAt
  })
  return { store, submission }
}

afterEach(async () => {
  services.splice(0).forEach((service) => service.close())
  stores.splice(0).forEach((store) => store.close())
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('AgentFeedbackService', () => {
  it('pairs explicitly, records admission, and correlates provider receipts', async () => {
    const generation = 'generation-123456'
    const bootstrapToken = 'bootstrap-token-12345678901234567890'
    const connectionToken = 'connection-token-12345678901234567890'
    const events: unknown[] = []
    const providerEvents: Array<Record<string, unknown>> = []
    let submissionRequest:
      | { deliveryIntent: string; prompt: string }
      | undefined
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/v1/pair') {
        const body = (await readBody(request)) as { bootstrapToken: string }
        expect(body.bootstrapToken).toBe(bootstrapToken)
        sendJson(response, 201, {
          protocolVersion: 1,
          connectionToken,
          connectionGeneration: generation,
          sessionId: 'session-1',
          readiness: 'idle',
          lastEventSequence: 0
        })
        return
      }
      expect(request.headers.authorization).toBe(`Bearer ${connectionToken}`)
      if (request.method === 'POST' && url.pathname === '/v1/bindings') {
        sendJson(response, 201, {
          bindingId: 'binding-1',
          generation,
          createdAt: new Date().toISOString()
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/submissions') {
        const body = (await readBody(request)) as {
          attemptId: string
          deliveryIntent: string
          prompt: string
        }
        submissionRequest = body
        providerEvents.push(
          {
            sequence: 1,
            type: 'submission.consumed',
            createdAt: new Date().toISOString(),
            data: { attemptId: body.attemptId, messageId: 'message-1' }
          },
          {
            sequence: 2,
            type: 'submission.reply',
            createdAt: new Date().toISOString(),
            data: {
              attemptId: body.attemptId,
              messageId: 'message-1',
              reply: 'Updated the title.'
            }
          },
          {
            sequence: 3,
            type: 'submission.idle',
            createdAt: new Date().toISOString(),
            data: { attemptId: body.attemptId, messageId: 'message-1' }
          }
        )
        sendJson(response, 202, {
          status: 'accepted',
          messageId: 'message-1',
          admittedAt: new Date().toISOString()
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        const cursor = Number(url.searchParams.get('cursor') ?? 0)
        const available = providerEvents.filter(
          (event) => Number(event.sequence) > cursor
        )
        sendJson(response, 200, {
          events: available,
          nextCursor:
            available.length > 0
              ? Number(available.at(-1)?.sequence)
              : cursor,
          readiness: 'idle'
        })
        return
      }
      sendJson(response, 404, { error: 'not found' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const pairingCode = `evp1:${Buffer.from(
      JSON.stringify({
        endpoint: `http://127.0.0.1:${port}/`,
        bootstrapToken,
        generation,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ).toString('base64url')}`
    const { store, submission } = await arrangeStore()
    const service = new AgentFeedbackService(store, (event: AgentEvent) => {
      events.push(event)
    })
    services.push(service)

    await service.pair(pairingCode)
    const admitted = await service.dispatch({
      storageDocumentId: 'document-storage-key',
      displayLabel: 'architecture.excalidraw',
      submission,
      mode: 'immediate',
      generation
    })

    expect(submissionRequest).toMatchObject({
      deliveryIntent: 'immediate'
    })
    expect(submissionRequest?.prompt).toContain(
      'This is an immediate collaboration turn.'
    )
    expect(submissionRequest?.prompt).toContain(
      'Do not turn a simple edit into a broad audit or refactor.'
    )
    expect(submissionRequest?.prompt).toContain(
      'Interaction traces use drawing coordinates'
    )
    expect(submissionRequest?.prompt).toContain('"type": "click"')
    expect(submissionRequest?.prompt).toContain('"title-element"')
    expect(admitted).toMatchObject({
      status: 'accepted',
      providerMessageId: 'message-1'
    })
    await waitFor(() =>
      events.some(
        (event) =>
          (event as AgentEvent).type === 'attempt' &&
          (event as Extract<AgentEvent, { type: 'attempt' }>).attempt.status ===
            'idle-after-turn'
      )
    )
    expect(await store.listAgentAttempts('document-storage-key')).toMatchObject([
      {
        status: 'idle-after-turn',
        reply: 'Updated the title.',
        providerMessageId: 'message-1'
      }
    ])
  })

  it('records unknown admission and blocks automatic queued replay', async () => {
    const generation = 'generation-unknown'
    const bootstrapToken = 'bootstrap-token-unknown-123456789012'
    const connectionToken = 'connection-token-unknown-123456789012'
    let submissionRequests = 0
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/v1/pair') {
        await readBody(request)
        sendJson(response, 201, {
          protocolVersion: 1,
          connectionToken,
          connectionGeneration: generation,
          sessionId: 'session-unknown',
          readiness: 'idle',
          lastEventSequence: 0
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/bindings') {
        sendJson(response, 201, {
          bindingId: 'binding-unknown',
          generation,
          createdAt: new Date().toISOString()
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/submissions') {
        submissionRequests += 1
        request.socket.destroy()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        sendJson(response, 200, {
          events: [],
          nextCursor: 0,
          readiness: 'idle'
        })
        return
      }
      sendJson(response, 404, { error: 'not found' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const pairingCode = `evp1:${Buffer.from(
      JSON.stringify({
        endpoint: `http://127.0.0.1:${port}/`,
        bootstrapToken,
        generation,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    ).toString('base64url')}`
    const { store, submission } = await arrangeStore()
    const service = new AgentFeedbackService(store, () => undefined)
    services.push(service)
    await service.pair(pairingCode)

    const unknown = await service.dispatch({
      storageDocumentId: 'document-storage-key',
      displayLabel: 'architecture.excalidraw',
      submission,
      mode: 'enqueue',
      generation
    })

    expect(unknown.status).toBe('unknown')
    await expect(
      service.preflight('enqueue')
    ).rejects.toThrow('unknown admission state')
    const blocked = await service.dispatch({
      storageDocumentId: 'document-storage-key',
      displayLabel: 'architecture.excalidraw',
      submission,
      mode: 'enqueue',
      generation
    })
    expect(blocked.status).toBe('rejected')
    expect(submissionRequests).toBe(1)
  })

  it('rejects before admission when binding creation fails', async () => {
    const generation = 'generation-binding-rejected'
    const bootstrapToken = 'bootstrap-token-binding-rejected-123456'
    const connectionToken = 'connection-token-binding-rejected-1234'
    let submissionRequests = 0
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/v1/pair') {
        await readBody(request)
        sendJson(response, 201, {
          protocolVersion: 1,
          connectionToken,
          connectionGeneration: generation,
          sessionId: 'session-binding-rejected',
          readiness: 'idle',
          lastEventSequence: 0
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/bindings') {
        sendJson(response, 409, { error: 'binding rejected' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/submissions') {
        submissionRequests += 1
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        sendJson(response, 200, {
          events: [],
          nextCursor: 0,
          readiness: 'idle'
        })
        return
      }
      sendJson(response, 404, { error: 'not found' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const { store, submission } = await arrangeStore()
    const service = new AgentFeedbackService(store, () => undefined)
    services.push(service)
    await service.pair(pairingCode(port, bootstrapToken, generation))

    const attempt = await service.dispatch({
      storageDocumentId: 'document-storage-key',
      displayLabel: 'architecture.excalidraw',
      submission,
      mode: 'enqueue',
      generation
    })

    expect(attempt).toMatchObject({
      status: 'rejected',
      detail: 'Delivery was rejected before dispatch: binding rejected'
    })
    expect(submissionRequests).toBe(0)
  })

  it('never redirects a generation-bound delivery after re-pairing', async () => {
    const oldGeneration = 'generation-old-task'
    const newGeneration = 'generation-new-task'
    let newTaskSubmissions = 0
    const createPairServer = (
      generation: string,
      bootstrapToken: string,
      connectionToken: string,
      countSubmissions: boolean
    ): ReturnType<typeof createServer> =>
      createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (request.method === 'POST' && url.pathname === '/v1/pair') {
          await readBody(request)
          sendJson(response, 201, {
            protocolVersion: 1,
            connectionToken,
            connectionGeneration: generation,
            sessionId: `session-${generation}`,
            readiness: 'idle',
            lastEventSequence: 0
          })
          return
        }
        if (request.method === 'POST' && url.pathname === '/v1/unpair') {
          sendJson(response, 200, {})
          return
        }
        if (request.method === 'POST' && url.pathname === '/v1/submissions') {
          if (countSubmissions) {
            newTaskSubmissions += 1
          }
          sendJson(response, 202, {
            status: 'accepted',
            messageId: 'unexpected-message',
            admittedAt: new Date().toISOString()
          })
          return
        }
        if (request.method === 'GET' && url.pathname === '/v1/events') {
          sendJson(response, 200, {
            events: [],
            nextCursor: 0,
            readiness: 'idle'
          })
          return
        }
        sendJson(response, 404, { error: 'not found' })
      })
    const oldServer = createPairServer(
      oldGeneration,
      'bootstrap-token-old-task-123456789012',
      'connection-token-old-task-123456789012',
      false
    )
    const newServer = createPairServer(
      newGeneration,
      'bootstrap-token-new-task-123456789012',
      'connection-token-new-task-123456789012',
      true
    )
    servers.push(oldServer, newServer)
    await Promise.all(
      [oldServer, newServer].map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve)
          )
      )
    )
    const oldAddress = oldServer.address()
    const newAddress = newServer.address()
    const oldPort =
      typeof oldAddress === 'object' && oldAddress ? oldAddress.port : 0
    const newPort =
      typeof newAddress === 'object' && newAddress ? newAddress.port : 0
    const { store, submission } = await arrangeStore()
    const service = new AgentFeedbackService(store, () => undefined)
    services.push(service)
    await service.pair(
      pairingCode(
        oldPort,
        'bootstrap-token-old-task-123456789012',
        oldGeneration
      )
    )
    const capturedGeneration = await service.preflight('enqueue')
    await service.pair(
      pairingCode(
        newPort,
        'bootstrap-token-new-task-123456789012',
        newGeneration
      )
    )

    const attempt = await service.dispatch({
      storageDocumentId: 'document-storage-key',
      displayLabel: 'architecture.excalidraw',
      submission,
      mode: 'enqueue',
      generation: capturedGeneration
    })

    expect(attempt.status).toBe('rejected')
    expect(attempt.detail).toContain('changed before dispatch')
    expect(newTaskSubmissions).toBe(0)
  })

  it('rejects companion responses larger than one MiB', async () => {
    const generation = 'generation-oversized-response'
    const bootstrapToken = 'bootstrap-token-oversized-response-1234'
    const server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/pair') {
        await readBody(request)
        sendJson(response, 201, {
          protocolVersion: 1,
          connectionToken: 'connection-token-oversized-response-1234',
          connectionGeneration: generation,
          sessionId: 'session-oversized',
          readiness: 'idle',
          lastEventSequence: 0,
          padding: 'x'.repeat(1024 * 1024)
        })
        return
      }
      sendJson(response, 404, { error: 'not found' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const { store } = await arrangeStore()
    const service = new AgentFeedbackService(store, () => undefined)
    services.push(service)

    await expect(
      service.pair(pairingCode(port, bootstrapToken, generation))
    ).rejects.toThrow('exceeded 1 MiB')
  })
})
