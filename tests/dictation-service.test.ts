import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DictationService, validateDictationRequest } from '../src/main/dictation-service'
import { encodePcm16Wav } from '../src/shared/audio'

const runtime = vi.hoisted(() => ({ root: '', packaged: false, spawn: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return runtime.packaged },
    getAppPath: () => runtime.root
  }
}))
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }))

const validRequest = () => ({
  jobId: 'job-1',
  documentId: 'document-1',
  draftId: 'draft-1',
  language: 'sv',
  wavData: new Uint8Array(encodePcm16Wav(new Float32Array([0, 0.25, -0.25])))
})

describe('dictation request validation', () => {
  it('accepts bounded 16 kHz mono PCM16 WAV data', () => {
    expect(validateDictationRequest(validRequest())).toMatchObject({
      jobId: 'job-1',
      documentId: 'document-1',
      draftId: 'draft-1',
      language: 'sv'
    })
  })
})

class EngineProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null))
    return true
  })
}

type EngineCall = { args: string[]; child: EngineProcess }
type EngineResponse = {
  json?: unknown
  raw?: string
  code?: number
  stderr?: string
  omitOutput?: boolean
}

const valueAfter = (args: readonly string[], flag: string): string => {
  const value = args[args.indexOf(flag) + 1]
  if (!value) throw new Error(`Missing engine argument: ${flag}`)
  return value
}

describe('local dictation model routing', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
  const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const launched = new EventEmitter()
  let service: DictationService
  let root: string
  let jobs: string
  let modelRoot: string
  let calls: EngineCall[]
  let responses: EngineResponse[]
  let automatic: boolean

  const complete = async (call: EngineCall, response: EngineResponse = {}): Promise<void> => {
    const detection = call.args.includes('-dl')
    if (!response.omitOutput) {
      await writeFile(`${valueAfter(call.args, '-of')}.json`,
        response.raw ?? JSON.stringify(response.json === undefined ? {
          result: { language: detection ? 'sv' : valueAfter(call.args, '-l') },
          transcription: detection ? [] : [{ text: ' Fixture transcript. ' }]
        } : response.json))
    }
    if (response.stderr) call.child.stderr.write(response.stderr)
    call.child.emit('close', response.code ?? 0)
  }

  const start = async (language = 'auto') => {
    automatic = false
    const next = once(launched, 'spawn')
    const result = service.transcribe({ ...validRequest(), language })
    await next
    return { result, call: calls[0]! }
  }

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    root = await mkdtemp(join(tmpdir(), 'visualizer-dictation-test-'))
    runtime.root = root
    runtime.packaged = false
    jobs = join(root, 'jobs')
    modelRoot = join(root, 'vendor', 'whisper', 'models')
    const binary = join(root, 'vendor', 'whisper', 'bin', 'windows-x64', 'Release', 'whisper-cli.exe')
    await mkdir(dirname(binary), { recursive: true })
    await mkdir(modelRoot, { recursive: true })
    await writeFile(binary, 'fixture')
    for (const name of ['ggml-small.bin', 'ggml-kb-whisper-small.bin', 'ggml-silero-v5.1.2.bin']) {
      await writeFile(join(modelRoot, name), 'fixture')
    }
    calls = []
    responses = []
    automatic = true
    runtime.spawn.mockImplementation((_binary: string, args: string[]) => {
      const call = { args, child: new EngineProcess() }
      calls.push(call)
      launched.emit('spawn', call)
      if (automatic) {
        setImmediate(() => {
          void complete(call, responses.shift()).catch((error: unknown) => call.child.emit('error', error))
        })
      }
      return call.child
    })
    service = new DictationService(jobs)
    await service.initialize()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await service.close()
    Object.defineProperty(process, 'platform', platformDescriptor)
    Object.defineProperty(process, 'arch', archDescriptor)
    if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
    else Reflect.deleteProperty(process, 'resourcesPath')
    await rm(root, { recursive: true, force: true })
  })

  it.each(['sv', 'en'])('routes explicit %s without a detection pass', async (language) => {
    const result = await service.transcribe({ ...validRequest(), language })
    expect(result).toEqual({ ok: true, text: 'Fixture transcript.', detectedLanguage: language })
    expect(calls).toHaveLength(1)
    expect(basename(valueAfter(calls[0]!.args, '-m')))
      .toBe(language === 'sv' ? 'ggml-kb-whisper-small.bin' : 'ggml-small.bin')
    expect(valueAfter(calls[0]!.args, '-l')).toBe(language)
    expect(calls[0]!.args).toContain('--vad')
    expect(calls[0]!.args).not.toContain('-dl')
    expect(await readdir(jobs)).toEqual([])
  })

  it.each(['sv', 'en', 'de', 'haw'])('detects %s before selecting its transcription model', async (language) => {
    responses.push({ json: { result: { language } } })
    expect(await service.transcribe({ ...validRequest(), language: 'auto' }))
      .toEqual({ ok: true, text: 'Fixture transcript.', detectedLanguage: language })
    expect(calls).toHaveLength(2)
    const [detection, transcription] = calls.map((call) => call.args)
    expect(basename(valueAfter(detection!, '-m'))).toBe('ggml-small.bin')
    expect(valueAfter(detection!, '-l')).toBe('auto')
    expect(detection).toContain('-dl')
    expect(transcription).not.toContain('-dl')
    expect(basename(valueAfter(transcription!, '-m')))
      .toBe(language === 'sv' ? 'ggml-kb-whisper-small.bin' : 'ggml-small.bin')
    expect(valueAfter(transcription!, '-l')).toBe(language)
    expect(valueAfter(detection!, '-of')).not.toBe(valueAfter(transcription!, '-of'))
    expect(await readdir(jobs)).toEqual([])
  })

  it('finds the same fixed assets in packaged resources', async () => {
    runtime.packaged = true
    Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true })
    expect(await service.transcribe(validRequest())).toMatchObject({ ok: true, detectedLanguage: 'sv' })
    expect(valueAfter(calls[0]!.args, '-m')).toBe(join(modelRoot, 'ggml-kb-whisper-small.bin'))
  })

  it.each(['sv', 'auto'])('reports missing Swedish weights for %s without fallback', async (language) => {
    await rm(join(modelRoot, 'ggml-kb-whisper-small.bin'))
    expect(await service.transcribe({ ...validRequest(), language })).toMatchObject({
      ok: false, message: expect.stringContaining('Swedish KB-Whisper small model is missing')
    })
    expect(calls).toHaveLength(language === 'auto' ? 1 : 0)
  })

  it('keeps English usable without Swedish weights', async () => {
    await rm(join(modelRoot, 'ggml-kb-whisper-small.bin'))
    expect(await service.transcribe({ ...validRequest(), language: 'en' })).toMatchObject({ ok: true })
  })

  it.each([null, [], {}, { params: { language: 'auto' } },
    { result: { language: 'auto' } }, { result: { language: '--help' } }
  ])('rejects absent or invalid detection metadata: %j', async (json) => {
    responses.push({ json })
    expect(await service.transcribe({ ...validRequest(), language: 'auto' })).toMatchObject({ ok: false })
    expect(calls).toHaveLength(1)
    expect(await readdir(jobs)).toEqual([])
  })

  it.each([
    { raw: 'not JSON' },
    { omitOutput: true },
    { code: 1, stderr: 'detection failed' }
  ])('never proceeds after detection failure: %j', async (response) => {
    responses.push(response)
    expect(await service.transcribe({ ...validRequest(), language: 'auto' })).toMatchObject({ ok: false })
    expect(calls).toHaveLength(1)
  })

  it('names the Swedish model when its weights are corrupt', async () => {
    responses.push({}, { code: 1, stderr: 'error: failed to load model' })
    expect(await service.transcribe({ ...validRequest(), language: 'auto' })).toMatchObject({
      ok: false, message: expect.stringContaining('ggml-kb-whisper-small.bin is incomplete or corrupt')
    })
  })

  it.each([{ transcription: [] }, { transcription: [{ text: '   ' }] }])(
    'reports silence without inventing a transcript: %j', async (json) => {
      responses.push({ json })
      expect(await service.transcribe(validRequest()))
        .toEqual({ ok: false, message: 'No speech was detected' })
    })

  it.each([null, { transcription: null }, { transcription: [null] },
    { transcription: [{ text: 42 }] }
  ])('rejects malformed transcript output: %j', async (json) => {
    responses.push({ json })
    expect(await service.transcribe(validRequest())).toMatchObject({ ok: false })
  })

  it('does not accept output from a failed process', async () => {
    responses.push({ code: 1, json: { transcription: [{ text: 'Partial output' }] } })
    expect(await service.transcribe(validRequest())).toMatchObject({ ok: false })
  })

  it('cancels during detection without starting transcription', async () => {
    const { result, call } = await start()
    expect(service.cancel('job-1')).toBe(true)
    expect(await result).toMatchObject({ ok: false, canceled: true })
    expect(call.child.kill).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(await readdir(jobs)).toEqual([])
  })

  it('honors cancellation between detection and transcription', async () => {
    const { result, call } = await start()
    await complete(call)
    service.cancel('job-1')
    expect(await result).toMatchObject({ ok: false, canceled: true })
    expect(calls).toHaveLength(1)
  })

  it('cancels the selected transcription process after detection', async () => {
    const { result, call } = await start()
    const next = once(launched, 'spawn')
    await complete(call)
    await next
    service.cancel('job-1')
    expect(await result).toMatchObject({ ok: false, canceled: true })
    expect(calls[1]!.child.kill).toHaveBeenCalledOnce()
  })

  it('does not insert a late transcript after cancellation', async () => {
    const { result, call } = await start('sv')
    await complete(call)
    service.cancel('job-1')
    expect(await result).toMatchObject({ ok: false, canceled: true })
  })

  it('serializes both Auto stages before the next job and rejects duplicate IDs', async () => {
    const { result, call } = await start()
    expect(await service.transcribe(validRequest())).toMatchObject({ ok: false })
    const secondResult = service.transcribe({ ...validRequest(), jobId: 'job-2', language: 'en' })
    const selected = once(launched, 'spawn')
    await complete(call)
    await selected
    expect(calls).toHaveLength(2)
    expect(valueAfter(calls[1]!.args, '-l')).toBe('sv')
    const nextJob = once(launched, 'spawn')
    await complete(calls[1]!)
    await nextJob
    expect(await result).toMatchObject({ ok: true, detectedLanguage: 'sv' })
    expect(valueAfter(calls[2]!.args, '-l')).toBe('en')
    await complete(calls[2]!)
    expect(await secondResult).toMatchObject({ ok: true, detectedLanguage: 'en' })
  })

  it('cancels queued work without spawning it', async () => {
    const { result } = await start()
    const queued = service.transcribe({ ...validRequest(), jobId: 'job-2' })
    expect(service.cancel('job-2')).toBe(true)
    expect(await queued).toMatchObject({ ok: false, canceled: true })
    service.cancel('job-1')
    await result
    expect(calls).toHaveLength(1)
  })

  it('shares one timeout budget across detection and transcription', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const started = Date.now()
    const { result, call } = await start()
    vi.setSystemTime(started + 30 * 60 * 1000 - 100)
    const selected = once(launched, 'spawn')
    await complete(call)
    await selected
    await vi.advanceTimersByTimeAsync(101)
    expect(await result).toMatchObject({ ok: false, message: 'Local dictation timed out' })
    expect(calls[1]!.child.kill).toHaveBeenCalledOnce()
  })

  it('bounds native process output', async () => {
    const { result, call } = await start('sv')
    call.child.stderr.write(Buffer.alloc(32 * 1024 * 1024 + 1))
    expect(await result).toMatchObject({
      ok: false, message: 'Dictation process output exceeded the safety limit'
    })
  })

  it('bounds transcript files before reading them', async () => {
    const { result, call } = await start('sv')
    const path = `${valueAfter(call.args, '-of')}.json`
    await writeFile(path, '')
    await truncate(path, 32 * 1024 * 1024 + 1)
    call.child.emit('close', 0)
    expect(await result).toMatchObject({
      ok: false, message: 'Dictation transcript exceeded the safety limit'
    })
  })
})

describe('dictation request validation errors', () => {
  it('rejects unsupported languages and unsafe identifiers', () => {
    expect(() =>
      validateDictationRequest({ ...validRequest(), language: 'translate' })
    ).toThrow('Unsupported dictation language')
    expect(() =>
      validateDictationRequest({ ...validRequest(), jobId: '../job' })
    ).toThrow('jobId is invalid')
  })

  it('rejects malformed and unexpected WAV formats', () => {
    expect(() =>
      validateDictationRequest({
        ...validRequest(),
        wavData: new Uint8Array(44)
      })
    ).toThrow('PCM WAV')

    const wrongRate = validRequest()
    new DataView(
      wrongRate.wavData.buffer,
      wrongRate.wavData.byteOffset,
      wrongRate.wavData.byteLength
    ).setUint32(24, 8_000, true)
    expect(() => validateDictationRequest(wrongRate)).toThrow(
      '16 kHz mono PCM16 WAV'
    )
  })
})
