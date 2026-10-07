// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationResult, DocumentEvent } from '../src/shared/contracts'
import { App } from '../src/renderer/src/App'

const audio = vi.hoisted(() => ({
  stop: vi.fn(),
  resume: vi.fn(),
  close: vi.fn(),
  nodes: [] as { port: { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null } }[]
}))

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
  restore: (scene: object) => scene,
  serializeAsJSON: (elements: unknown, appState: unknown, files: unknown) =>
    JSON.stringify({ type: 'excalidraw', version: 2, elements, appState, files }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI: (api: object) => void }) => {
    useEffect(() => {
      excalidrawAPI({
        getSceneElements: () => [],
        getAppState: () => ({
          selectedElementIds: {}, scrollX: 0, scrollY: 0,
          zoom: { value: 1 }, viewBackgroundColor: '#ffffff'
        }),
        getFiles: () => ({}),
        updateScene: () => undefined
      })
    }, [excalidrawAPI])
    return createElement('div', { className: 'excalidraw' })
  }
}))

vi.mock('../src/renderer/src/export-image', () => ({ renderExport: vi.fn() }))

let documentListener: (event: DocumentEvent) => void
let root: Root
let container: HTMLDivElement
const deviceEvents = new EventTarget()
const pairedConnection = {
  paired: true, readiness: 'ready', sessionId: 'test-session',
  generation: 'test-generation', blockedReason: null, lastEventSequence: 0, detail: null
}
const stream = {
  getTracks: () => [{ stop: audio.stop }],
  getAudioTracks: () => [{ label: 'USB microphone' }]
}
const mediaDevices = {
  enumerateDevices: vi.fn(),
  getUserMedia: vi.fn(),
  addEventListener: deviceEvents.addEventListener.bind(deviceEvents),
  removeEventListener: deviceEvents.removeEventListener.bind(deviceEvents)
}
const desktop = {
  getAppVersion: vi.fn(),
  onUpdateProgress: () => () => undefined,
  onDocumentEvent: (listener: (event: DocumentEvent) => void) => {
    documentListener = listener
    return () => undefined
  },
  onAppCommand: () => () => undefined,
  onAgentEvent: () => () => undefined,
  rendererReady: vi.fn(),
  setActiveDocument: vi.fn(),
  setDirty: vi.fn(),
  listFeedback: vi.fn(),
  listAgentActivity: vi.fn(),
  getCopilotCompanionStatus: vi.fn(),
  transcribe: vi.fn(),
  cancelDictation: vi.fn(),
  upsertFeedback: vi.fn(),
  deliverFeedback: vi.fn()
}

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

const click = async (label: string): Promise<void> => {
  await act(async () => button(label).click())
}

const feedbackText = (): HTMLTextAreaElement => {
  const textarea = container.querySelector('.feedback-text-label textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Feedback text is missing')
  return textarea
}

const typeFeedback = async (text: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      feedbackText(), text
    )
    feedbackText().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const startWithAudio = async (): Promise<void> => {
  await click('Start dictating')
  await act(async () => {
    audio.nodes.at(-1)?.port.onmessage?.(
      new MessageEvent('message', { data: new Float32Array([0, 0.5, -0.5]).buffer })
    )
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  audio.nodes.length = 0
  window.localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('desktop', desktop)
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()
  }))
  vi.stubGlobal('AudioContext', class {
    state: AudioContextState = 'suspended'
    sampleRate = 16_000
    destination = {}
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
    async resume(): Promise<void> { audio.resume(); this.state = 'running' }
    async close(): Promise<void> { audio.close(); this.state = 'closed' }
    createMediaStreamSource(): object {
      return { connect: vi.fn(), disconnect: vi.fn() }
    }
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null }
    connect = vi.fn()
    disconnect = vi.fn()
    constructor() { audio.nodes.push(this) }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: mediaDevices
  })
  mediaDevices.enumerateDevices.mockResolvedValue([
    { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' }
  ])
  mediaDevices.getUserMedia.mockResolvedValue(stream)
  desktop.getAppVersion.mockResolvedValue('0.6.1')
  desktop.rendererReady.mockResolvedValue([])
  desktop.listFeedback.mockResolvedValue({ feedback: [], submissions: [] })
  desktop.listAgentActivity.mockResolvedValue({ connection: pairedConnection, attempts: [] })
  desktop.getCopilotCompanionStatus.mockResolvedValue({ state: 'current' })
  desktop.transcribe.mockResolvedValue({ ok: true, text: 'Change this label.' })
  desktop.cancelDictation.mockResolvedValue(true)
  desktop.upsertFeedback.mockImplementation(async (draft: unknown) => draft)
  desktop.deliverFeedback.mockResolvedValue({ attempt: { status: 'accepted' } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(App)))
  await act(async () => documentListener({
    type: 'opened',
    document: {
      id: 'test-document', path: null, fingerprint: '',
      scene: {
        type: 'excalidraw', version: 2, elements: [],
        appState: { viewBackgroundColor: '#ffffff' }, files: {}
      }
    }
  }))
  await click('Give feedback')
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('dictation feedback UI', () => {
  it('opens no microphone until explicitly requested and uses the selected input', async () => {
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
    const select = container.querySelector('[aria-label="Microphone"]')
    if (!(select instanceof HTMLSelectElement)) throw new Error('Microphone selector is missing')
    await act(async () => {
      select.value = 'usb'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(window.localStorage.getItem('excalidraw-visualizer-microphone')).toBe('usb')
    await startWithAudio()
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ deviceId: { exact: 'usb' } }),
      video: false
    }))
    expect(audio.resume).toHaveBeenCalledOnce()
    expect(container.querySelector('.microphone-meter')?.textContent).toContain('USB microphone')
    expect(container.querySelector('meter')?.value).toBe(0.5)
    expect(button('Cancel')).toBeDefined()
    expect(button('Transcribe')).toBeDefined()
    expect(button('Send feedback')).toBeDefined()
  })

  it('releases microphone access after explicitly refreshing inputs', async () => {
    await click('Refresh microphones')
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    expect(audio.stop).toHaveBeenCalledOnce()
    expect(audio.nodes).toHaveLength(0)
    expect(button('Start dictating').disabled).toBe(false)
  })

  it('transcribes for review without submitting even when paired', async () => {
    await typeFeedback('Keep this text.')
    await startWithAudio()
    await click('Transcribe')
    expect(desktop.transcribe).toHaveBeenCalledOnce()
    expect(feedbackText().value).toBe('Keep this text. Change this label.')
    expect(feedbackText().disabled).toBe(false)
    expect(desktop.deliverFeedback).not.toHaveBeenCalled()
    expect(desktop.upsertFeedback).not.toHaveBeenCalled()
    expect(button('Send now').disabled).toBe(false)
    expect(audio.stop).toHaveBeenCalledOnce()
  })

  it('keeps direct send available and clears feedback after accepted delivery', async () => {
    await startWithAudio()
    await click('Send feedback')
    expect(desktop.transcribe).toHaveBeenCalledOnce()
    expect(desktop.deliverFeedback).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'immediate', documentId: 'test-document'
    }))
    expect(feedbackText().value).toBe('')
    expect(button('Start dictating').disabled).toBe(false)
  })

  it('continues recording when cancellation is declined, and preserves typed text when confirmed', async () => {
    await typeFeedback('Do not lose this.')
    await startWithAudio()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await click('Cancel')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Are you sure'))
    expect(audio.stop).not.toHaveBeenCalled()
    expect(button('Transcribe')).toBeDefined()
    confirm.mockReturnValue(true)
    await click('Cancel')
    expect(audio.stop).toHaveBeenCalledOnce()
    expect(desktop.transcribe).not.toHaveBeenCalled()
    expect(feedbackText().value).toBe('Do not lose this.')
    expect(button('Start dictating').disabled).toBe(false)
  })

  it.each(['Transcribe', 'Send feedback'])('does not send or insert a canceled result from %s', async (action) => {
    let resolveTranscript: (result: DictationResult) => void = () => undefined
    desktop.transcribe.mockImplementation(() => new Promise<DictationResult>((resolve) => {
      resolveTranscript = resolve
    }))
    await startWithAudio()
    await click(action)
    expect(container.querySelector('.feedback-progress[role="status"]')?.textContent)
      .toBe(action === 'Transcribe' ? 'Transcribing locally…' : 'Transcribing locally, then sending…')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await click('Cancel transcription')
    expect(desktop.cancelDictation).toHaveBeenCalledOnce()
    await act(async () => resolveTranscript({ ok: true, text: 'Late result', detectedLanguage: 'en' }))
    expect(feedbackText().value).toBe('')
    expect(desktop.deliverFeedback).not.toHaveBeenCalled()
  })

  it('shows actionable permission errors without losing the draft', async () => {
    await typeFeedback('Existing text.')
    mediaDevices.getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
    await click('Start dictating')
    expect(container.querySelector('.feedback-message')?.textContent)
      .toContain('Microphone access was denied')
    expect(feedbackText().value).toBe('Existing text.')
    expect(button('Start dictating').disabled).toBe(false)
  })

  it('retains the selected input after unplugging instead of silently switching', async () => {
    const select = container.querySelector('[aria-label="Microphone"]')
    if (!(select instanceof HTMLSelectElement)) throw new Error('Microphone selector is missing')
    await act(async () => {
      select.value = 'usb'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'other', label: 'Other microphone' }
    ])
    await act(async () => deviceEvents.dispatchEvent(new Event('devicechange')))
    expect(select.value).toBe('usb')
    expect(container.querySelector('.microphone-controls')?.textContent)
      .toContain('selected microphone is unavailable')
    mediaDevices.getUserMedia.mockRejectedValueOnce(
      new DOMException('Missing selected device', 'OverconstrainedError')
    )
    await click('Start dictating')
    expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ deviceId: { exact: 'usb' } })
    }))
    expect(feedbackText().disabled).toBe(false)
  })

  it('allows review without a paired task', async () => {
    desktop.listAgentActivity.mockResolvedValue({
      connection: { ...pairedConnection, paired: false, readiness: 'disconnected' },
      attempts: []
    })
    await act(async () => {
      root.unmount()
      root = createRoot(container)
      root.render(createElement(App))
    })
    await act(async () => documentListener({
      type: 'opened',
      document: {
        id: 'unpaired-document', path: null, fingerprint: '',
        scene: {
          type: 'excalidraw', version: 2, elements: [],
          appState: { viewBackgroundColor: '#ffffff' }, files: {}
        }
      }
    }))
    await click('Give feedback')
    await startWithAudio()
    expect([...container.querySelectorAll('.dictation-controls button')]
      .some((control) => control.textContent?.trim() === 'Send feedback')).toBe(false)
    await click('Transcribe')
    expect(feedbackText().value).toBe('Change this label.')
    expect(desktop.deliverFeedback).not.toHaveBeenCalled()
  })

  it('reports empty capture without discarding existing text', async () => {
    await typeFeedback('Existing text.')
    await click('Start dictating')
    await click('Transcribe')
    expect(container.querySelector('.feedback-message')?.textContent)
      .toContain('No microphone audio was captured')
    expect(feedbackText().value).toBe('Existing text.')
    expect(desktop.transcribe).not.toHaveBeenCalled()
    expect(button('Start dictating').disabled).toBe(false)
  })
})
