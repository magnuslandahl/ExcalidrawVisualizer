import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import {
  mkdir,
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
await mkdir(profilePath)
const debuggingPort = await getAvailablePort()
const processOutput = []

await writeFile(
  scenePath,
  `${JSON.stringify(sceneWithBackground('#ffffff'), null, 2)}\n`,
  'utf8'
)
const feedbackTestScene = `${JSON.stringify(sceneWithBackground('#fff4e6', [{
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
  }]), null, 2)}\n`
await writeFile(secondScenePath, feedbackTestScene, 'utf8')

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
      EXCALIDRAW_VISUALIZER_SMOKE_TEST: '1',
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
    const pathForEditor = (editor) =>
      document.querySelector(
        '.document-tab[data-document-id="' + editor.dataset.documentId +
        '"] .document-tab__select'
      )?.getAttribute('title') ?? ''
    const targetEditor =
      activeEditors.find((editor) => pathForEditor(editor) === targetPath) ??
      activeEditors[0] ?? null
    const tabStrip = document.querySelector('.document-tab-strip')
    const bar = document.querySelector('.workspace-bar')
    const toolbar = targetEditor?.querySelector('.App-toolbar')
    return {
      readyState: document.readyState,
      preloadBridge:
        typeof window.desktop?.openPath === 'function' &&
        typeof window.desktop?.checkForUpdates === 'function' &&
        typeof window.desktop?.exportDrawing === 'function',
      appVersion: document.querySelector('.app-version')?.textContent?.trim() ?? '',
      updateLabel: document.querySelector('.update-button')?.textContent?.trim() ?? '',
      tabOverflowY: tabStrip ? getComputedStyle(tabStrip).overflowY : '',
      documentPath: targetEditor ? pathForEditor(targetEditor) : '',
      status: document.querySelector('.workspace-actions > .status')?.textContent?.trim() ?? '',
      barHeight: bar?.getBoundingClientRect().height ?? 0,
      editAction: document.querySelector('.mode-button')?.textContent?.trim() ?? '',
      toolbarVisible: toolbar
        ? getComputedStyle(toolbar).display !== 'none' &&
          toolbar.getBoundingClientRect().height > 0
        : false,
      toolbarLabels: [...(toolbar?.querySelectorAll('[aria-label]') ?? [])]
        .map((element) => element.getAttribute('aria-label')).slice(0, 16),
      oldToolbarCount: document.querySelectorAll('.document-toolbar').length,
      tabs: [...document.querySelectorAll('.document-tab')].map((tab) => ({
        name: tab.querySelector('.document-tab__select span')?.textContent ?? '',
        selected: tab.classList.contains('document-tab--active'),
        width: tab.getBoundingClientRect().width
      })),
      split: document.querySelector('.workspace')?.classList.contains('workspace--split') ?? false,
      visibleEditors: activeEditors.map((editor) => ({
        documentPath: pathForEditor(editor),
        shell: rect(editor.querySelector('.canvas-shell')),
        canvases: [...editor.querySelectorAll('canvas')].map(rect)
      })),
      workspace: rect(document.querySelector('.workspace')),
      canvasShell: rect(targetEditor?.querySelector('.canvas-shell')),
      canvases: [
        ...(targetEditor?.querySelectorAll('.canvas-shell canvas') ?? [])
      ].map(rect),
      canvasBackground:
        document.querySelector('.workspace-menu input[type="color"]')?.value ?? '',
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

  await waitFor(
    () => connection.evaluate(
      `Boolean(document.querySelector('.workspace-overflow > button[aria-label="More actions"]'))`
    ),
    Boolean,
    'compact workspace bar'
  )
  await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-overflow > button[aria-label="More actions"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('More actions is unavailable')
    button.click()
  })()`)
  const initialState = await waitFor(
    () => readRendererState(connection),
    (state) =>
      state.readyState === 'complete' &&
      state.preloadBridge &&
      /\d+\.\d+\.\d+/.test(state.appVersion) &&
      state.updateLabel === 'Check for updates' &&
      state.tabOverflowY === 'hidden' &&
      state.barHeight > 0 && state.barHeight <= 48 &&
      state.oldToolbarCount === 0 &&
      state.editAction === 'Edit' &&
      !state.toolbarVisible &&
      [scenePath, secondScenePath].includes(state.documentPath) &&
      state.tabs.length === 2 &&
      state.tabs.every((tab) => tab.width > 260) &&
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
    const button = [...document.querySelectorAll('.workspace-actions button')]
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
          barHidden:
            getComputedStyle(document.querySelector('.workspace-bar')).display === 'none',
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
      state.barHidden &&
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
      type: 'mouseMoved',
      x: pointer.x - 90,
      y: pointer.y - 40
    })
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pointer.x,
      y: pointer.y
    })
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
        Number(context.match(/(\d+) interactions?/)?.[1] ?? 0) >= 2,
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
  if (testRecordingSelection && (await readFile(secondScenePath, 'utf8')) !== feedbackTestScene) {
    throw new Error('Viewing or giving feedback changed the drawing file')
  }
  await connection.evaluate(`(() => {
    const targetName = ${JSON.stringify(basename(scenePath))}
    const tab = [...document.querySelectorAll('.document-tab')]
      .find((candidate) =>
        candidate.querySelector('.document-tab__select span')?.textContent === targetName
      )
    const selectButton = tab?.querySelector('.document-tab__select')
    if (!(selectButton instanceof HTMLButtonElement)) {
      throw new Error('The empty drawing tab is unavailable')
    }
    selectButton.click()
  })()`)
  await waitFor(
    () => readRendererState(connection),
    (state) => state.documentPath === scenePath,
    'the empty drawing to become active for export'
  )
  await connection.evaluate(`(() => {
    const button = document.querySelector('[aria-label="Export drawing"]')
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('The Export control is unavailable')
    }
    button.click()
  })()`)
  const exportOptions = await waitFor(
    () => connection.evaluate(
      `[...document.querySelectorAll('#export-menu button')].map((choice) => choice.textContent?.trim())`
    ),
    (choices) => choices.join('|') === 'SVG (vector)|PNG (2× raster)|WEBP (2× raster)',
    'SVG, PNG, and WebP export options'
  )
  await connection.evaluate(`(() => {
    const option = document.querySelector('#export-menu button')
    if (!(option instanceof HTMLButtonElement)) {
      throw new Error('The SVG export action is unavailable')
    }
    option.click()
  })()`)
  await waitFor(
    () => connection.evaluate(
      `document.querySelector('.document-pane--active .banner')?.textContent?.trim() ?? ''`
    ),
    (message) => message.includes('Could not export SVG: There are no elements to export'),
    'empty-scene export error without opening a save dialog'
  )
  const bannerLayout = await connection.evaluate(`(() => {
    const pane = document.querySelector('.document-pane--active')
    const banner = pane?.querySelector('.banner')
    const canvas = pane?.querySelector('.canvas-shell')
    if (!pane || !banner || !canvas) throw new Error('Export error layout is unavailable')
    const paneBounds = pane.getBoundingClientRect()
    const bannerBounds = banner.getBoundingClientRect()
    const canvasBounds = canvas.getBoundingClientRect()
    return {
      paneWidth: paneBounds.width,
      paneHeight: paneBounds.height,
      bannerWidth: bannerBounds.width,
      bannerHeight: bannerBounds.height,
      bannerBottom: bannerBounds.bottom,
      canvasWidth: canvasBounds.width,
      canvasHeight: canvasBounds.height,
      canvasTop: canvasBounds.top
    }
  })()`)
  if (
    bannerLayout.bannerWidth < bannerLayout.paneWidth - 2 ||
    bannerLayout.bannerHeight > 80 ||
    bannerLayout.bannerBottom > bannerLayout.canvasTop + 1 ||
    bannerLayout.canvasWidth < bannerLayout.paneWidth - 2 ||
    bannerLayout.canvasHeight < bannerLayout.paneHeight - 80
  ) {
    throw new Error(`Export message obscured the canvas: ${JSON.stringify(bannerLayout)}`)
  }
  const bridgeRejection = await connection.evaluate(`(async () => {
    try {
      await window.desktop.exportDrawing({
        documentId: 'missing-document',
        format: 'svg',
        data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
      })
      return 'Unexpected export success'
    } catch (error) {
      return String(error)
    }
  })()`)
  if (!bridgeRejection.includes('The requested document is not open')) {
    throw new Error(`Export IPC failed to validate the document: ${bridgeRejection}`)
  }
  if ((await readFile(scenePath, 'utf8')) !== `${JSON.stringify(sceneWithBackground('#ffffff'), null, 2)}\n`) {
    throw new Error('Exporting the empty scene changed its source file')
  }
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
      'the synthetic drawing to become active after export'
    )
    const pointer = await connection.evaluate(`(() => {
      const rect = document.querySelector('.editor-slot--active .canvas-shell')
        ?.getBoundingClientRect()
      if (!rect) throw new Error('Viewing canvas is unavailable')
      return { x: rect.left + 270, y: rect.top + 245 }
    })()`)
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1
    })
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: pointer.x + 50, y: pointer.y + 30, button: 'left'
    })
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: pointer.x + 50, y: pointer.y + 30, button: 'left',
      clickCount: 1
    })
  }

  if (shouldCheckUpdates) {
    await connection.evaluate(`(() => {
      const more = document.querySelector('.workspace-overflow > button[aria-label="More actions"]')
      if (!(more instanceof HTMLButtonElement)) {
        throw new Error('More actions is unavailable')
      }
      more.click()
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

  const splitState = await waitFor(
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
      ) &&
      state.editAction === 'Edit' &&
      !state.toolbarVisible,
    'two visible drawing panes with non-zero canvas layers'
  )

  const replacementPath = join(tempRoot, '.packaged-smoke-replacement')
  await writeFile(
    replacementPath,
    `${JSON.stringify(sceneWithBackground('#f0e8ff'), null, 2)}\n`,
    'utf8'
  )
  await rename(replacementPath, scenePath)

  await connection.evaluate(`(() => {
    const mode = document.querySelector('.mode-button')
    const more = document.querySelector('.workspace-overflow > button[aria-label="More actions"]')
    if (!(mode instanceof HTMLButtonElement) || !(more instanceof HTMLButtonElement)) {
      throw new Error('View/Edit controls are unavailable')
    }
    mode.click()
    more.click()
  })()`)
  const editModeState = await waitFor(
    () => readRendererState(connection),
    (state) =>
      state.documentPath === scenePath &&
      state.editAction === 'View' &&
      state.toolbarVisible &&
      state.toolbarLabels.includes('Rectangle') &&
      state.canvasBackground === '#f0e8ff',
    'the external update and editing mode background control'
  )
  await connection.evaluate(`(() => {
    const input = document.querySelector('.workspace-menu input[type="color"]')
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
  if (testRecordingSelection && (await readFile(secondScenePath, 'utf8')) !== feedbackTestScene) {
    throw new Error('Dragging in view mode modified the drawing')
  }

  console.log(
    JSON.stringify(
      {
        package: packagePath,
        architecture: process.arch,
        preloadBridge: true,
        appVersion: initialState.appVersion,
        updateControl: initialState.updateLabel,
        manualUpdateCheck: manualUpdateState,
        feedbackCanvasFocus: feedbackFocusState.barHidden,
        feedbackPanelWidth: feedbackFocusState.panelWidth,
        automaticFeedbackContext:
          feedbackFocusState.automaticContext.includes('Whole drawing') &&
          feedbackFocusState.targetButtonCount === 0,
        recordingElementSelection: testRecordingSelection ? true : 'not-tested',
        exportFormats: exportOptions.length,
        emptyExportRejected: true,
        exportBridgeValidated: true,
        compactBarHeight: initialState.barHeight,
        wideTabs: initialState.tabs.every((tab) => tab.width > 260),
        viewerDefault: initialState.editAction === 'Edit',
        viewerToolbarHidden: !initialState.toolbarVisible,
        splitViewerToolbarHidden: !splitState.toolbarVisible,
        editToolbarVisible: editModeState.toolbarVisible,
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
