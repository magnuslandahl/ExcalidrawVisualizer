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

const canvasElements = vi.hoisted(() => [
  { id: 'box-a', type: 'rectangle', x: 10, y: 10, width: 100, height: 80,
    angle: 0, isDeleted: false, version: 1, versionNonce: 1 },
  { id: 'box-b', type: 'rectangle', x: 200, y: 10, width: 100, height: 80,
    angle: 0, isDeleted: false, version: 1, versionNonce: 2 }
])

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
  restore: (scene: object) => scene,
  serializeAsJSON: (elements: unknown, appState: unknown, files: unknown) =>
    JSON.stringify({ type: 'excalidraw', version: 2, elements, appState, files }),
  viewportCoordsToSceneCoords: (point: { clientX: number; clientY: number }) =>
    ({ x: point.clientX, y: point.clientY }),
  Excalidraw: ({ excalidrawAPI, onChange }: {
    excalidrawAPI: (api: object) => void
    onChange: (elements: object[], state: object, files: object) => void
  }) => {
    useEffect(() => {
      const state = {
        selectedElementIds: {}, scrollX: 0, scrollY: 0,
        zoom: { value: 1 }, viewBackgroundColor: '#ffffff'
      }
      excalidrawAPI({
        getSceneElements: () => canvasElements,
        getAppState: () => state,
        getFiles: () => ({}),
        updateScene: () => undefined
      })
      onChange(canvasElements, state, {})
    }, [excalidrawAPI, onChange])
    return createElement('div', { className: 'excalidraw' },
      createElement('canvas', { className: 'excalidraw__canvas' }))
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
  deliverFeedback: vi.fn(),
  copyFeedbackSubmission: vi.fn()
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

const expectFeedbackIcons = (): void => {
  const buttons = [...container.querySelectorAll('.feedback-panel button')]
  expect(buttons.length).toBeGreaterThan(0)
  for (const control of buttons) {
    const icon = control.querySelector('svg')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.getAttribute('focusable')).toBe('false')
    expect(control.getAttribute('aria-label') || control.textContent?.trim()).toBeTruthy()
  }
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
  desktop.copyFeedbackSubmission.mockResolvedValue({ feedback: [{}] })
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
  const pointer = async (type: string, x: number, y = 30, button = 0): Promise<void> => {
    await act(async () => {
      const canvas = container.querySelector('canvas')
      if (!canvas) throw new Error('Missing canvas')
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      canvas.dispatchEvent(event)
    })
  }
  const selectItem = async (x: number): Promise<void> => {
    await pointer('pointerdown', x)
    await pointer('pointerup', x)
  }
  const shortcut = async (): Promise<void> => {
    await act(async () => feedbackText().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    ))
  }

  it('labels every feedback button with an icon and keeps the four actions together', async () => {
    expectFeedbackIcons()
    expect([...container.querySelectorAll('.feedback-composer-actions > button')]
      .map((control) => control.textContent?.trim())).toEqual(['Clear', 'Copy', 'Queue', 'Send now'])
    await click('Write')
    await selectItem(30)
    expectFeedbackIcons()
    await click('Speak')
    await startWithAudio()
    expectFeedbackIcons()
  })

  it('supports silent selection, stable references, caret restoration and immediate delivery', async () => {
    await click('Write')
    expect(window.localStorage.getItem('excalidraw-visualizer-feedback-mode')).toBe('write')
    expect(container.querySelector('.microphone-controls')).toBeNull()
    await typeFeedback('Move 1 next to 2.')
    feedbackText().setSelectionRange(5, 5)
    await pointer('pointermove', 220)
    expect(container.querySelector('.feedback-anchor--hover')).not.toBeNull()
    expect(container.querySelector('.feedback-reference-list')).toBeNull()
    await selectItem(220)
    await selectItem(30)
    await selectItem(220)
    expect(container.querySelectorAll('[data-feedback-element]')).toHaveLength(2)
    expect(document.activeElement).toBe(feedbackText())
    expect(feedbackText().selectionStart).toBe(5)
    const remove = container.querySelector('[aria-label="Remove item 1: rectangle"]')
    if (!(remove instanceof HTMLButtonElement)) throw new Error('Missing removal chip')
    await act(async () => remove.click())
    await selectItem(220)
    expect([...container.querySelectorAll('[data-feedback-element] span')]
      .map((badge) => badge.textContent)).toEqual(['2', '3'])
    await shortcut()
    expect(desktop.upsertFeedback).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Move 1 next to 2.',
      interactionTrace: [],
      elementReferences: [
        { number: 2, elementId: 'box-a', label: 'rectangle' },
        { number: 3, elementId: 'box-b', label: 'rectangle' }
      ]
    }))
    expect(desktop.deliverFeedback).toHaveBeenCalledOnce()
    expect(container.querySelector('.feedback-reference-list')).toBeNull()
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(desktop.transcribe).not.toHaveBeenCalled()
  })

  it('does not select while panning, on secondary clicks or canceled gestures', async () => {
    await click('Write')
    await pointer('pointerdown', 30)
    await pointer('pointermove', 220)
    await pointer('pointerup', 30)
    await pointer('pointerdown', 30, 30, 2)
    await pointer('pointerup', 30, 30, 2)
    await pointer('pointerdown', 30)
    await pointer('pointercancel', 30)
    await pointer('pointerup', 30)
    expect(container.querySelector('.feedback-reference-list')).toBeNull()
    await selectItem(30)
    await click('Clear items')
    expect(container.querySelector('.feedback-auto-context')?.textContent).toContain('Whole drawing')
  })

  it('copies numbered selections with the shortcut when unpaired', async () => {
    desktop.listAgentActivity.mockResolvedValue({
      connection: { ...pairedConnection, paired: false, readiness: 'disconnected' }, attempts: []
    })
    desktop.getCopilotCompanionStatus.mockResolvedValue({ state: 'not-installed' })
    await act(async () => {
      root.unmount()
      root = createRoot(container)
      root.render(createElement(App))
    })
    await act(async () => documentListener({
      type: 'opened',
      document: {
        id: 'test-document', path: null, fingerprint: '',
        scene: { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }
      }
    }))
    await click('Give feedback')
    expectFeedbackIcons()
    expect(button('Install Copilot companion')).toBeDefined()
    await click('Write')
    await typeFeedback('Update item 1.')
    await selectItem(30)
    await shortcut()
    expect(desktop.copyFeedbackSubmission).toHaveBeenCalledOnce()
    expect(desktop.upsertFeedback).toHaveBeenCalledWith(expect.objectContaining({
      elementReferences: [{ number: 1, elementId: 'box-a', label: 'rectangle' }]
    }))
    expect(desktop.deliverFeedback).not.toHaveBeenCalled()
  })

  it('keeps selections across mode switches, recording and transcript review', async () => {
    await click('Write')
    await selectItem(30)
    await click('Speak')
    await startWithAudio()
    await selectItem(220)
    await click('Transcribe')
    expect(container.querySelectorAll('[data-feedback-element]')).toHaveLength(2)
    await click('Write')
    await click('Copy')
    expect(desktop.upsertFeedback).toHaveBeenCalledWith(expect.objectContaining({
      interactionTrace: [],
      elementReferences: [
        { number: 1, elementId: 'box-a', label: 'rectangle' },
        { number: 2, elementId: 'box-b', label: 'rectangle' }
      ]
    }))
  })

  it('requires removing unavailable items instead of silently changing the target', async () => {
    await click('Write')
    await typeFeedback('Update 1.')
    await selectItem(30)
    const element = canvasElements[0]!
    element.isDeleted = true
    try {
      await click('Copy')
      expect(container.querySelector('.feedback-message')?.textContent).toContain('no longer available')
      expect(desktop.upsertFeedback).not.toHaveBeenCalled()
      expect(desktop.copyFeedbackSubmission).not.toHaveBeenCalled()
      expect(feedbackText().value).toBe('Update 1.')
    } finally {
      element.isDeleted = false
    }
  })

  it('does not select the empty corners of an ellipse or rotated item', async () => {
    await click('Write')
    const element = canvasElements[0]!
    try {
      element.type = 'ellipse'
      await selectItem(11)
      expect(container.querySelector('.feedback-reference-list')).toBeNull()
      element.type = 'rectangle'
      element.angle = Math.PI / 4
      await pointer('pointerdown', 11, 11)
      await pointer('pointerup', 11, 11)
      expect(container.querySelector('.feedback-reference-list')).toBeNull()
      await selectItem(60)
      expect(container.querySelectorAll('[data-feedback-element]')).toHaveLength(1)
    } finally {
      element.type = 'rectangle'
      element.angle = 0
    }
  })

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
