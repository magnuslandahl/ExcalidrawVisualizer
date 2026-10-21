import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  isDictationLanguage,
  type DictationRequest,
  type DictationResult
} from '../shared/contracts'

const maxWavBytes = 10 * 1024 * 1024
const maxOutputBytes = 32 * 1024 * 1024
const transcriptionTimeoutMs = 30 * 60 * 1000
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

type QueuedJob = {
  request: DictationRequest
  resolve: (result: DictationResult) => void
}

type WhisperOutput = {
  language: string | null
  text: string
}

const validateId = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

export const validateDictationRequest = (value: unknown): DictationRequest => {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid dictation request')
  }
  const request = value as Partial<DictationRequest>
  const jobId = validateId('jobId', request.jobId)
  const documentId = validateId('documentId', request.documentId)
  const draftId = validateId('draftId', request.draftId)
  if (!isDictationLanguage(request.language)) {
    throw new TypeError('Unsupported dictation language')
  }
  if (!(request.wavData instanceof Uint8Array)) {
    throw new TypeError('Dictation audio must be a Uint8Array')
  }
  if (request.wavData.byteLength < 44 || request.wavData.byteLength > maxWavBytes) {
    throw new TypeError('Dictation audio size is invalid')
  }
  const header = new TextDecoder('ascii').decode(request.wavData.subarray(0, 12))
  if (!header.startsWith('RIFF') || !header.endsWith('WAVE')) {
    throw new TypeError('Dictation audio must be a PCM WAV file')
  }
  const view = new DataView(
    request.wavData.buffer,
    request.wavData.byteOffset,
    request.wavData.byteLength
  )
  if (
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16_000 ||
    view.getUint16(34, true) !== 16
  ) {
    throw new TypeError('Dictation audio must be 16 kHz mono PCM16 WAV')
  }
  return {
    jobId,
    documentId,
    draftId,
    language: request.language,
    wavData: request.wavData
  }
}

const resourceRoot = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'vendor', 'whisper')
    : resolve(app.getAppPath(), 'vendor', 'whisper')

const binaryCandidates = (): string[] => {
  const root = resourceRoot()
  if (process.platform === 'darwin') {
    return [join(root, 'bin', 'macos-universal', 'whisper-cli')]
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    const base = join(root, 'bin', 'windows-x64')
    return [
      'whisper-cli.exe',
      'main.exe',
      'whisper.exe',
      join('Release', 'whisper-cli.exe'),
      join('bin', 'whisper-cli.exe'),
      join('build', 'bin', 'Release', 'whisper-cli.exe')
    ].map((path) => join(base, path))
  }
  return []
}

const firstFile = async (
  paths: readonly string[],
  description: string
): Promise<string> => {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) {
        return path
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') {
        throw error
      }
    }
  }
  throw new Error(
    `Bundled ${description} is missing. Reinstall the app or run npm run prepare-whisper in a development checkout.`
  )
}

const readWhisperOutput = async (prefix: string): Promise<WhisperOutput> => {
  const path = `${prefix}.json`
  try {
    if ((await stat(path)).size > maxOutputBytes) {
      throw new Error('Dictation transcript exceeded the safety limit')
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Local dictation did not produce its expected output')
    }
    throw error
  }
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Local dictation returned invalid output')
  }
  const result = 'result' in parsed ? parsed.result : null
  const language = result && typeof result === 'object' && 'language' in result
    ? result.language
    : 'language' in parsed ? parsed.language : null
  const segments = 'transcription' in parsed ? parsed.transcription : []
  if (!Array.isArray(segments)) {
    throw new Error('Local dictation returned an invalid transcript')
  }
  const text = segments.map((segment: unknown) => {
    if (!segment || typeof segment !== 'object' ||
        !('text' in segment) || typeof segment.text !== 'string') {
      throw new Error('Local dictation returned an invalid transcript segment')
    }
    return segment.text.trim()
  }).filter(Boolean).join(' ')
  return {
    language: typeof language === 'string' && /^[a-z]{2,3}$/.test(language)
      ? language : null,
    text
  }
}

const appendBounded = (current: Buffer, chunk: Buffer): Buffer => {
  if (current.byteLength + chunk.byteLength > maxOutputBytes) {
    throw new Error('Dictation process output exceeded the safety limit')
  }
  return Buffer.concat([current, chunk])
}

export class DictationService {
  readonly #temporaryRoot: string
  readonly #queue: QueuedJob[] = []
  readonly #canceled = new Set<string>()
  #runningJobId: string | undefined
  #active:
    | {
        jobId: string
        child: ChildProcess
      }
    | undefined

  constructor(temporaryRoot: string) {
    this.#temporaryRoot = temporaryRoot
  }

  async initialize(): Promise<void> {
    await mkdir(this.#temporaryRoot, { recursive: true })
    for (const entry of await readdir(this.#temporaryRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('job-')) {
        await rm(join(this.#temporaryRoot, entry.name), {
          recursive: true,
          force: true
        })
      }
    }
  }

  transcribe(value: unknown): Promise<DictationResult> {
    let request: DictationRequest
    try {
      request = validateDictationRequest(value)
    } catch (error) {
      return Promise.resolve({
        ok: false,
        message: error instanceof Error ? error.message : 'Invalid dictation request'
      })
    }
    if (
      this.#runningJobId === request.jobId ||
      this.#active?.jobId === request.jobId ||
      this.#queue.some((job) => job.request.jobId === request.jobId)
    ) {
      return Promise.resolve({ ok: false, message: 'That dictation job already exists' })
    }

    return new Promise((resolveJob) => {
      this.#queue.push({ request, resolve: resolveJob })
      void this.#pump()
    })
  }

  cancel(value: unknown): boolean {
    const jobId = validateId('jobId', value)
    const queuedIndex = this.#queue.findIndex((job) => job.request.jobId === jobId)
    if (queuedIndex >= 0) {
      const [job] = this.#queue.splice(queuedIndex, 1)
      job?.resolve({ ok: false, canceled: true, message: 'Dictation canceled' })
      return true
    }
    if (this.#runningJobId === jobId) {
      this.#canceled.add(jobId)
      this.#active?.child.kill()
      return true
    }
    return false
  }

  async close(): Promise<void> {
    for (const job of this.#queue.splice(0)) {
      job.resolve({ ok: false, canceled: true, message: 'Application is closing' })
    }
    if (this.#active) {
      this.#canceled.add(this.#active.jobId)
      this.#active.child.kill()
    } else if (this.#runningJobId) {
      this.#canceled.add(this.#runningJobId)
    }
  }

  async #pump(): Promise<void> {
    if (this.#runningJobId || this.#queue.length === 0) {
      return
    }
    const job = this.#queue.shift()
    if (!job) {
      return
    }
    this.#runningJobId = job.request.jobId
    try {
      const result = await this.#run(job.request)
      job.resolve(this.#canceled.has(job.request.jobId)
        ? { ok: false, canceled: true, message: 'Dictation canceled' }
        : result)
    } catch (error) {
      job.resolve({
        ok: false,
        message: error instanceof Error ? error.message : 'Dictation failed'
      })
    } finally {
      this.#active = undefined
      this.#runningJobId = undefined
      this.#canceled.delete(job.request.jobId)
      void this.#pump()
    }
  }

  async #run(request: DictationRequest): Promise<DictationResult> {
    const deadline = Date.now() + transcriptionTimeoutMs
    const jobDirectory = join(
      this.#temporaryRoot,
      `job-${request.jobId}-${randomUUID()}`
    )
    await mkdir(jobDirectory, { recursive: false })
    const wavPath = join(jobDirectory, 'input.wav')
    const outputPrefix = join(jobDirectory, `transcript-${randomUUID()}`)

    try {
      await writeFile(wavPath, request.wavData, { mode: 0o600 })
      if (this.#canceled.has(request.jobId)) {
        return { ok: false, canceled: true, message: 'Dictation canceled' }
      }
      const root = resourceRoot()
      const binary = await firstFile(binaryCandidates(), 'dictation executable')
      const vad = await firstFile([
        join(root, 'models', 'ggml-silero-v5.1.2.bin')
      ], 'Silero VAD model')
      const runModel = async (
        model: string,
        language: string,
        prefix: string,
        detectLanguage = false
      ): Promise<WhisperOutput> => {
        const args = [
          '-m', model, '-f', wavPath, '-oj', '-of', prefix,
          '-t', String(Math.max(1, Math.min(cpus().length - 1, 8))),
          '-l', language, '--vad', '--vad-model', vad,
          ...(detectLanguage ? ['-dl'] : [])
        ]
        await this.#execute(request.jobId, binary, args, deadline, basename(model))
        return readWhisperOutput(prefix)
      }
      let language: string = request.language
      if (language === 'auto') {
        const detector = await firstFile([
          join(root, 'models', 'ggml-small.bin')
        ], 'multilingual Whisper small model')
        const detection = await runModel(detector, 'auto', `${outputPrefix}-language`, true)
        if (!detection.language) {
          throw new Error(
            'Local dictation did not detect a language. Choose Svenska or English and try again.'
          )
        }
        language = detection.language
      }
      const model = await firstFile([
        join(root, 'models', language === 'sv' ? 'ggml-kb-whisper-small.bin' : 'ggml-small.bin')
      ], language === 'sv' ? 'Swedish KB-Whisper small model' : 'multilingual Whisper small model')
      const { text } = await runModel(model, language, outputPrefix)
      if (!text) {
        return { ok: false, message: 'No speech was detected' }
      }
      return { ok: true, text, detectedLanguage: language }
    } catch (error) {
      if (this.#canceled.has(request.jobId)) {
        return { ok: false, canceled: true, message: 'Dictation canceled' }
      }
      throw error
    } finally {
      await rm(jobDirectory, { recursive: true, force: true })
    }
  }

  async #execute(
    jobId: string,
    binary: string,
    args: readonly string[],
    deadline: number,
    modelName: string
  ): Promise<void> {
    if (this.#canceled.has(jobId)) {
      throw new Error('Dictation canceled')
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error('Local dictation timed out')
    }
    try {
      await new Promise<void>((resolveProcess, rejectProcess) => {
        const child = spawn(binary, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        this.#active = { jobId, child }
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
        let outputError: Error | undefined
        const timeout = setTimeout(() => {
          outputError = new Error('Local dictation timed out')
          child.kill()
        }, remainingMs)

        child.stdout.on('data', (chunk: Buffer) => {
          try {
            stdout = appendBounded(stdout, chunk)
          } catch (error) {
            outputError = error instanceof Error ? error : new Error(String(error))
            child.kill()
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          try {
            stderr = appendBounded(stderr, chunk)
          } catch (error) {
            outputError = error instanceof Error ? error : new Error(String(error))
            child.kill()
          }
        })
        child.once('error', (error) => {
          clearTimeout(timeout)
          rejectProcess(error)
        })
        child.once('close', (code) => {
          clearTimeout(timeout)
          if (outputError) {
            rejectProcess(outputError)
          } else if (this.#canceled.has(jobId)) {
            resolveProcess()
          } else if (code === 0) {
            resolveProcess()
          } else {
            const detail = stderr.toString('utf8').trim().split('\n').slice(-3).join(' ')
            rejectProcess(
              new Error(/not all tensors loaded|failed to load model/i.test(detail)
                ? `Bundled dictation model ${modelName} is incomplete or corrupt. Reinstall the app or run npm run prepare-whisper.`
                : `Local dictation using ${modelName} exited with code ${String(code)}${
                  detail ? `: ${detail}` : ''
                }`
              )
            )
          }
        })
      })
    } finally {
      this.#active = undefined
    }
  }
}
