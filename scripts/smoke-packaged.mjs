import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const packagePathArgument = process.argv[2]
const shouldCheckUpdates = process.argv.includes('--check-update')
const testRecordingSelection = process.platform === 'win32'
const WebSocketClient = globalThis.WebSocket

if (!packagePathArgument) {
  throw new Error(
    'Usage: npm run smoke:packaged -- <path-to-app-or-executable>'
  )
}
if (typeof WebSocketClient !== 'function') {
  throw new Error('This smoke test requires Node.js with built-in WebSocket support')
}
const packagePath = resolve(packagePathArgument)
const executablePath =
  process.platform === 'darwin'
    ? join(packagePath, 'Contents', 'MacOS', 'ExcalidrawVisualizer')
    : packagePath

await stat(executablePath)

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const getAvailablePort = async () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Unable to reserve a debugging port'))
        return
      }
      server.close((error) => {
        if (error) {
          rejectPort(error)
        } else {
          resolvePort(address.port)
        }
      })
    })
  })

const sceneWithBackground = (viewBackgroundColor, elements = []) => ({
  type: 'excalidraw',
  version: 2,
  source: 'excalidraw-visualizer-packaged-smoke-test',
  elements,
  appState: {
    viewBackgroundColor
  },
  files: {}
})

const tempRoot = await realpath(
  await mkdtemp(join(tmpdir(), 'excalidraw-visualizer-smoke-'))
)
const scenePath = join(tempRoot, 'packaged-smoke.excalidraw')
const secondScenePath = join(tempRoot, 'packaged-smoke-second.excalidraw')
const profilePath = join(tempRoot, 'profile')
const debuggingPort = await getAvailablePort()
const processOutput = []

await writeFile(
  scenePath,
  `${JSON.stringify(sceneWithBackground('#ffffff'), null, 2)}\n`,
  'utf8'
)
await writeFile(
  secondScenePath,
  `${JSON.stringify(sceneWithBackground('#fff4e6', [{
    id: 'feedback-test-rectangle',
    type: 'rectangle',
    x: 200,
    y: 200,
    width: 140,
    height: 100,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: '#ffec99',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 101,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false
  }]), null, 2)}\n`,
  'utf8'
)

const child = spawn(
  executablePath,
  [
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
    ...(testRecordingSelection
      ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
      : []),
    scenePath,
    secondScenePath
  ],
  {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    processOutput.push(chunk)
    if (processOutput.length > 100) {
      processOutput.shift()
    }
  })
}

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = []

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(
        typeof event.data === 'string'
          ? event.data
          : Buffer.from(event.data).toString('utf8')
      )
      if (message.id) {
        const request = this.pending.get(message.id)
        if (!request) {
          return
        }
        this.pending.delete(message.id)
        if (message.error) {
          request.reject(new Error(message.error.message))
        } else {
          request.resolve(message.result)
        }
        return
      }
      this.events.push(message)
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text
      )
    }
    return response.result.value
  }

  close() {
    this.socket.close()
  }

  closeBrowser() {
    const id = this.nextId
    this.nextId += 1
    this.socket.send(JSON.stringify({ id, method: 'Browser.close', params: {} }))
  }
}

const connectToRenderer = async () => {
  const deadline = Date.now() + 30_000
  let lastError

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged app exited early with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/list`
      )
      const targets = await response.json()
      const target = targets.find(
        (candidate) =>
          candidate.type === 'page' &&
          candidate.webSocketDebuggerUrl
      )
      if (target) {
        const socket = new WebSocketClient(target.webSocketDebuggerUrl)
        await new Promise((resolveSocket, rejectSocket) => {
          socket.addEventListener('open', resolveSocket, { once: true })
          socket.addEventListener('error', rejectSocket, { once: true })
        })
        return new DevToolsConnection(socket)
      }
    } catch (error) {
      lastError = error
    }
    await delay(150)
  }

  throw new Error(
    `Timed out waiting for the packaged renderer${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`
  )
}

const readRendererState = (connection) =>
  connection.evaluate(`(() => {
    const rect = (element) => {
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height }
    }
    const activeEditors = [...document.querySelectorAll('.editor-slot--active')]
    const targetPath = ${JSON.stringify(scenePath)}
    const targetEditor =
      activeEditors.find(
        (editor) =>
          editor.querySelector('.document-identity span')?.getAttribute('title') ===
          targetPath
      ) ?? activeEditors[0] ?? null
    const tabStrip = document.querySelector('.document-tab-strip')
    return {
      readyState: document.readyState,
      preloadBridge:
        typeof window.desktop?.openPath === 'function' &&
        typeof window.desktop?.checkForUpdates === 'function',
      appVersion: document.querySelector('.app-version')?.textContent?.trim() ?? '',
      updateLabel: document.querySelector('.update-button')?.textContent?.trim() ?? '',
      tabOverflowY: tabStrip ? getComputedStyle(tabStrip).overflowY : '',
      documentName:
        targetEditor?.querySelector('.document-identity strong')?.textContent ?? '',
      documentPath:
        targetEditor?.querySelector('.document-identity span')?.getAttribute('title') ?? '',
      status: targetEditor?.querySelector('.status')?.textContent?.trim() ?? '',
      tabs: [...document.querySelectorAll('.document-tab')].map((tab) => ({
        name: tab.querySelector('.document-tab__select span')?.textContent ?? '',
        selected: tab.classList.contains('document-tab--active')
      })),
      split: document.querySelector('.workspace')?.classList.contains('workspace--split') ?? false,
      visibleEditors: activeEditors.map((editor) => ({
        documentPath:
          editor.querySelector('.document-identity span')?.getAttribute('title') ?? '',
        canvasBackground: editor.querySelector('input[type="color"]')?.value ?? '',
        shell: rect(editor.querySelector('.canvas-shell')),
        canvases: [...editor.querySelectorAll('canvas')].map(rect)
      })),
      workspace: rect(document.querySelector('.workspace')),
      canvasShell: rect(targetEditor?.querySelector('.canvas-shell')),
      canvases: [
        ...(targetEditor?.querySelectorAll('.canvas-shell canvas') ?? [])
      ].map(rect),
      canvasBackground:
        targetEditor?.querySelector('input[type="color"]')?.value ?? '',
      resources: performance.getEntriesByType('resource').map((entry) => entry.name)
    }
  })()`)

const waitFor = async (readValue, isReady, description) => {
  const deadline = Date.now() + 20_000
  let value
  while (Date.now() < deadline) {
    value = await readValue()
    if (isReady(value)) {
      return value
    }
    await delay(100)
  }
  throw new Error(
    `Timed out waiting for ${description}. Last value: ${JSON.stringify(value)}`
  )
}

let connection
let manualUpdateState = 'not-requested'

try {
  connection = await connectToRenderer()
  await Promise.all([
    connection.send('Runtime.enable'),
    connection.send('Log.enable'),
    connection.send('Network.enable')
  ])

  const initialState = await waitFor(
    () => readRendererState(connection),
    (state) =>
      state.readyState === 'complete' &&
      state.preloadBridge &&
      /^\d+\.\d+\.\d+/.test(state.appVersion) &&
      state.updateLabel === 'Check for updates' &&
      state.tabOverflowY === 'hidden' &&
      [scenePath, secondScenePath].includes(state.documentPath) &&
      state.tabs.length === 2 &&
      state.tabs.some((tab) => tab.name === basename(scenePath)) &&
      state.tabs.some((tab) => tab.name === basename(secondScenePath)) &&
      state.workspace?.width > 0 &&
      state.workspace?.height > 0 &&
      state.visibleEditors.length === 1 &&
      state.visibleEditors[0].shell?.width > 0 &&
      state.visibleEditors[0].shell?.height > 0 &&
      state.visibleEditors[0].canvases.filter(
        (canvas) => canvas?.width > 0 && canvas?.height > 0
      ).length >= 2,
    'both launch-path tabs and non-zero canvas layers'
  )

  if (testRecordingSelection) {
    await connection.evaluate(`(() => {
      const targetName = ${JSON.stringify(basename(secondScenePath))}
      const tab = [...document.querySelectorAll('.document-tab')]
        .find((candidate) =>
          candidate.querySelector('.document-tab__select span')?.textContent === targetName
        )
      const selectButton = tab?.querySelector('.document-tab__select')
      if (!(selectButton instanceof HTMLButtonElement)) {
        throw new Error('The synthetic drawing tab is unavailable')
      }
      selectButton.click()
    })()`)
    await waitFor(
      () => readRendererState(connection),
      (state) => state.documentPath === secondScenePath,
      'synthetic feedback drawing to become active'
    )
  }

  await connection.evaluate(`(() => {
    const button = [...document.querySelectorAll('.editor-slot--active .document-toolbar button')]
      .find((candidate) => candidate.textContent?.trim() === 'Give feedback')
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('The Give feedback control is unavailable')
    }
    button.click()
  })()`)
  const feedbackFocusState = await waitFor(
    () =>
      connection.evaluate(`(() => {
        const app = document.querySelector('.app')
        const panel = document.querySelector('.feedback-panel')
        const canvas = document.querySelector('.editor-slot--active .canvas-shell')
        return {
          active: app?.classList.contains('app--feedback-active') ?? false,
          appHeaderHidden:
            getComputedStyle(document.querySelector('.app-header')).display === 'none',
          tabsHidden:
            getComputedStyle(document.querySelector('.document-tabs')).display === 'none',
          toolbarHidden:
            getComputedStyle(
              document.querySelector('.editor-slot--active .document-toolbar')
            ).display === 'none',
          panelWidth: panel?.getBoundingClientRect().width ?? 0,
          canvasHeight: canvas?.getBoundingClientRect().height ?? 0,
          automaticContext:
            panel?.querySelector('.feedback-auto-context')?.textContent?.trim() ?? '',
          startAction: [...(panel?.querySelectorAll('button') ?? [])]
            .map((button) => button.textContent?.trim())
            .find((label) => label === 'Start dictating') ?? '',
          targetButtonCount:
            panel?.querySelectorAll('.feedback-target-actions button').length ?? 0
        }
      })()`),
    (state) =>
      state.active &&
      state.appHeaderHidden &&
      state.tabsHidden &&
      state.toolbarHidden &&
      state.panelWidth > 0 &&
      state.panelWidth <= 342 &&
      state.canvasHeight > (initialState.canvasShell?.height ?? 0) &&
      state.automaticContext.includes('Whole drawing') &&
      state.startAction === 'Start dictating' &&
      state.targetButtonCount === 0,
    'canvas-first feedback mode'
  )
  if (testRecordingSelection) {
    await connection.evaluate(`(() => {
      const button = [...document.querySelectorAll('.feedback-panel button')]
        .find((candidate) => candidate.textContent?.trim() === 'Start dictating')
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('The Start dictating control is unavailable')
      }
      button.click()
    })()`)
    await waitFor(
      () => connection.evaluate(
        `document.querySelector('.feedback-panel h2')?.textContent?.trim() ?? ''`
      ),
      (heading) => heading === 'Recording feedback',
      'fake microphone recording'
    )
    const pointer = await connection.evaluate(`(() => {
      const rect = document.querySelector('.editor-slot--active .canvas-shell')
        ?.getBoundingClientRect()
      if (!rect) throw new Error('Feedback canvas is unavailable')
      return { x: rect.left + 270, y: rect.top + 245 }
    })()`)
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pointer.x,
      y: pointer.y,
      button: 'left',
      clickCount: 1
    })
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pointer.x,
      y: pointer.y,
      button: 'left',
      clickCount: 1
    })
    await waitFor(
      () => connection.evaluate(
        `document.querySelector('.feedback-auto-context')?.textContent?.trim() ?? ''`
      ),
      (context) =>
        context.includes('1 selected element') &&
        context.includes('1 interaction'),
      'selected element feedback context during recording'
    )
    await connection.evaluate(`(() => {
      const button = [...document.querySelectorAll('.feedback-panel button')]
        .find((candidate) => candidate.textContent?.trim() === 'Stop without transcript')
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('The cancel recording control is unavailable')
      }
      button.click()
    })()`)
    await waitFor(
      () => connection.evaluate(
        `document.querySelector('.feedback-panel h2')?.textContent?.trim() ?? ''`
      ),
      (heading) => heading === 'Give feedback',
      'recording cancellation'
    )
  }
  await connection.evaluate(`(() => {
    const button = document.querySelector('.feedback-panel > header > button')
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('The feedback close control is unavailable')
    }
    button.click()
  })()`)
  await waitFor(
    () =>
      connection.evaluate(
        `!document.querySelector('.app')?.classList.contains('app--feedback-active')`
      ),
    Boolean,
    'feedback mode to close'
  )

  if (shouldCheckUpdates) {
    await connection.evaluate(`(() => {
      const button = document.querySelector('.update-button')
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('The update control is unavailable')
      }
      button.click()
    })()`)
    manualUpdateState = await waitFor(
      () =>
        connection.evaluate(
          `document.querySelector('.update-button')?.textContent?.trim() ?? ''`
        ),
      (label) =>
        label === 'No update available' || label.startsWith('Install '),
      'the manual update check'
    )
  }

  await connection.evaluate(`(() => {
    const targetName = ${JSON.stringify(basename(scenePath))}
    const targetTab = [...document.querySelectorAll('.document-tab')].find(
      (tab) =>
        tab.querySelector('.document-tab__select span')?.textContent === targetName
    )
    if (!(targetTab instanceof HTMLElement)) {
      throw new Error('The target drawing tab is unavailable')
    }
    targetTab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 100,
      clientY: 70
    }))
  })()`)
  await waitFor(
    () =>
      connection.evaluate(`(() => {
        const moveButton = [...document.querySelectorAll('.tab-context-menu button')]
          .find((button) => button.textContent?.toLowerCase().includes('move to side view'))
        if (moveButton instanceof HTMLButtonElement) {
          moveButton.click()
          return true
        }
        return false
      })()`),
    Boolean,
    'the side-view context-menu command'
  )

  await waitFor(
    () => readRendererState(connection),
    (state) =>
      state.split &&
      state.visibleEditors.length === 2 &&
      state.visibleEditors.every(
        (editor) =>
          editor.shell?.width > 0 &&
          editor.shell?.height > 0 &&
          editor.canvases.filter(
            (canvas) => canvas?.width > 0 && canvas?.height > 0
          ).length >= 2
      ),
    'two visible drawing panes with non-zero canvas layers'
  )

  const replacementPath = join(tempRoot, '.packaged-smoke-replacement')
  await writeFile(
    replacementPath,
    `${JSON.stringify(sceneWithBackground('#f0e8ff'), null, 2)}\n`,
    'utf8'
  )
  await rename(replacementPath, scenePath)

  await waitFor(
    () => readRendererState(connection),
    (state) =>
      state.documentPath === scenePath &&
      state.canvasBackground === '#f0e8ff',
    'the external update routed to its drawing tab'
  )

  await connection.evaluate(`(() => {
    const targetPath = ${JSON.stringify(scenePath)}
    const targetEditor = [...document.querySelectorAll('.editor-slot--active')].find(
      (editor) =>
        editor.querySelector('.document-identity span')?.getAttribute('title') ===
        targetPath
    )
    const input = targetEditor?.querySelector('input[type="color"]')
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Canvas background input is unavailable')
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set
    setter.call(input, '#dbeafe')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)

  await waitFor(
    async () => {
      const savedScene = JSON.parse(await readFile(scenePath, 'utf8'))
      return savedScene.appState?.viewBackgroundColor
    },
    (background) => background === '#dbeafe',
    'the packaged application save'
  )

  await connection.evaluate(`(() => {
    const selectedTab = document.querySelector('.document-tab--active')
    if (!(selectedTab instanceof HTMLElement)) {
      throw new Error('The selected drawing tab is unavailable')
    }
    selectedTab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 120,
      clientY: 70
    }))
  })()`)
  await waitFor(
    () =>
      connection.evaluate(`(() => {
        const detachButton = [...document.querySelectorAll('.tab-context-menu button')]
          .find((button) => button.textContent?.toLowerCase().includes('move to new window'))
        if (detachButton instanceof HTMLButtonElement) {
          detachButton.click()
          return true
        }
        return false
      })()`),
    Boolean,
    'the new-window context-menu command'
  )

  await waitFor(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/list`
      )
      const targets = await response.json()
      const state = await readRendererState(connection)
      return {
        pageTargets: targets.filter((target) => target.type === 'page').length,
        originalTabs: state.tabs.length
      }
    },
    (state) => state.pageTargets === 2 && state.originalTabs === 1,
    'tab detachment into a second application window'
  )

  const finalState = await readRendererState(connection)
  const remoteResources = finalState.resources.filter((resource) =>
    /^https?:\/\//i.test(resource)
  )
  const protocolErrors = connection.events.filter(
    (event) =>
      event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Runtime.consoleAPICalled' &&
        event.params.type === 'error') ||
      (event.method === 'Log.entryAdded' &&
        event.params.entry.level === 'error') ||
      (event.method === 'Network.loadingFailed' &&
        !event.params.canceled)
  )

  if (remoteResources.length > 0) {
    throw new Error(
      `Packaged renderer requested remote resources: ${remoteResources.join(', ')}`
    )
  }
  if (protocolErrors.length > 0) {
    throw new Error(
      `Packaged renderer reported errors: ${JSON.stringify(protocolErrors)}`
    )
  }

  console.log(
    JSON.stringify(
      {
        package: packagePath,
        architecture: process.arch,
        preloadBridge: true,
        appVersion: finalState.appVersion,
        updateControl: finalState.updateLabel,
        manualUpdateCheck: manualUpdateState,
        feedbackCanvasFocus:
          feedbackFocusState.appHeaderHidden &&
          feedbackFocusState.tabsHidden &&
          feedbackFocusState.toolbarHidden,
        feedbackPanelWidth: feedbackFocusState.panelWidth,
        automaticFeedbackContext:
          feedbackFocusState.automaticContext.includes('Whole drawing') &&
          feedbackFocusState.targetButtonCount === 0,
        recordingElementSelection: testRecordingSelection ? true : 'not-tested',
        tabOverflowHidden: finalState.tabOverflowY === 'hidden',
        launchPathTabs: initialState.tabs.length,
        canvasLayers: initialState.canvases.length,
        splitView: true,
        externalAtomicUpdate: true,
        applicationSave: true,
        detachedWindow: true,
        remoteRequests: remoteResources.length,
        rendererErrors: protocolErrors.length
      },
      null,
      2
    )
  )
} catch (error) {
  const output = processOutput.join('').trim()
  if (output) {
    console.error(output)
  }
  throw error
} finally {
  if (connection) {
    connection.closeBrowser()
  } else {
    child.kill('SIGTERM')
  }

  const exited = child.exitCode !== null || child.signalCode !== null || await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(5_000).then(() => false)
  ])
  if (!exited) {
    child.kill('SIGTERM')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
  connection?.close()
  await rm(tempRoot, { recursive: true, force: true })
}
