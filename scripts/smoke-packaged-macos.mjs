import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import WebSocket from 'ws'

const appPathArgument = process.argv[2]

if (process.platform !== 'darwin') {
  throw new Error('The packaged macOS smoke test must run on macOS')
}
if (!appPathArgument) {
  throw new Error('Usage: npm run smoke:mac -- release/mac-arm64/ExcalidrawVisualizer.app')
}
const appPath = resolve(appPathArgument)
const executablePath = join(
  appPath,
  'Contents',
  'MacOS',
  'ExcalidrawVisualizer'
)

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

const sceneWithBackground = (viewBackgroundColor) => ({
  type: 'excalidraw',
  version: 2,
  source: 'excalidraw-visualizer-packaged-smoke-test',
  elements: [],
  appState: {
    viewBackgroundColor
  },
  files: {}
})

const tempRoot = await mkdtemp(join(tmpdir(), 'excalidraw-visualizer-smoke-'))
const scenePath = join(tempRoot, 'packaged-smoke.excalidraw')
const profilePath = join(tempRoot, 'profile')
const debuggingPort = await getAvailablePort()
const processOutput = []

await writeFile(
  scenePath,
  `${JSON.stringify(sceneWithBackground('#ffffff'), null, 2)}\n`,
  'utf8'
)

const child = spawn(
  executablePath,
  [
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
    scenePath
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
        const socket = new WebSocket(target.webSocketDebuggerUrl)
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
    return {
      readyState: document.readyState,
      preloadBridge: typeof window.desktop?.openPath === 'function',
      documentName: document.querySelector('.document-identity strong')?.textContent ?? '',
      documentPath: document.querySelector('.document-identity span')?.getAttribute('title') ?? '',
      status: document.querySelector('.status')?.textContent?.trim() ?? '',
      workspace: rect(document.querySelector('.workspace')),
      canvasShell: rect(document.querySelector('.canvas-shell')),
      canvases: [...document.querySelectorAll('.canvas-shell canvas')].map(rect),
      canvasBackground: document.querySelector('input[type="color"]')?.value ?? '',
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
      state.documentName === basename(scenePath) &&
      state.documentPath === scenePath &&
      state.workspace?.width > 0 &&
      state.workspace?.height > 0 &&
      state.canvasShell?.width > 0 &&
      state.canvasShell?.height > 0 &&
      state.canvases.filter(
        (canvas) => canvas?.width > 0 && canvas?.height > 0
      ).length >= 2,
    'the launch-path drawing and non-zero canvas layers'
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
    (state) => state.canvasBackground === '#f0e8ff',
    'the atomic external update'
  )

  await connection.evaluate(`(() => {
    const input = document.querySelector('input[type="color"]')
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
        app: appPath,
        architecture: process.arch,
        preloadBridge: true,
        launchPath: true,
        canvasLayers: initialState.canvases.length,
        externalAtomicUpdate: true,
        applicationSave: true,
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
