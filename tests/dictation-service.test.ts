import { describe, expect, it, vi } from 'vitest'
import { validateDictationRequest } from '../src/main/dictation-service'
import { encodePcm16Wav } from '../src/shared/audio'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

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
