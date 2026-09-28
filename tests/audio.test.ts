import { describe, expect, it } from 'vitest'
import {
  AUDIO_TARGET_SAMPLE_RATE,
  downsampleMonoPcmTo16Khz,
  encodePcm16Wav,
  MAX_AUDIO_DURATION_SECONDS
} from '../src/shared/audio'

const ascii = (view: DataView, offset: number, length: number): string =>
  Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join(
    ''
  )

describe('audio helpers', () => {
  it('writes a valid mono PCM16 WAV header and data size', () => {
    const samples = new Float32Array([0, 0.5, -0.5])
    const buffer = encodePcm16Wav(samples)
    const view = new DataView(buffer)

    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(42)
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(AUDIO_TARGET_SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect(buffer.byteLength).toBe(50)
  })

  it('clips samples when encoding PCM16', () => {
    const view = new DataView(encodePcm16Wav(new Float32Array([-2, -1, 0, 1, 2])))

    expect(Array.from({ length: 5 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual(
      [-32768, -32768, 0, 32767, 32767]
    )
  })

  it('downsamples to 16 kHz while preserving duration', () => {
    const sourceRate = 48_000
    const source = Float32Array.from(
      { length: sourceRate * 2 },
      (_, index) => Math.sin((index / sourceRate) * Math.PI * 2 * 440)
    )

    const result = downsampleMonoPcmTo16Khz(source, sourceRate)

    expect(result).toHaveLength(AUDIO_TARGET_SAMPLE_RATE * 2)
    expect(result).not.toBe(source)
  })

  it('rejects invalid rates, samples, and empty input', () => {
    expect(() => downsampleMonoPcmTo16Khz(new Float32Array([0]), 0)).toThrow(RangeError)
    expect(() => downsampleMonoPcmTo16Khz(new Float32Array([0]), 8_000)).toThrow(
      RangeError
    )
    expect(() => encodePcm16Wav(new Float32Array([0]), 16_000.5)).toThrow(RangeError)
    expect(() => encodePcm16Wav(new Float32Array(), AUDIO_TARGET_SAMPLE_RATE)).toThrow(
      RangeError
    )
    expect(() =>
      encodePcm16Wav(new Float32Array([Number.NaN]), AUDIO_TARGET_SAMPLE_RATE)
    ).toThrow(RangeError)
    expect(() =>
      encodePcm16Wav(new Float32Array([Number.POSITIVE_INFINITY]), AUDIO_TARGET_SAMPLE_RATE)
    ).toThrow(RangeError)
  })

  it('accepts the maximum duration and rejects longer input', () => {
    const maximum = new Float32Array(
      AUDIO_TARGET_SAMPLE_RATE * MAX_AUDIO_DURATION_SECONDS
    )
    const overlong = new Float32Array(maximum.length + 1)

    expect(downsampleMonoPcmTo16Khz(maximum, AUDIO_TARGET_SAMPLE_RATE)).toHaveLength(
      maximum.length
    )
    expect(() =>
      downsampleMonoPcmTo16Khz(overlong, AUDIO_TARGET_SAMPLE_RATE)
    ).toThrow(RangeError)
    expect(() => encodePcm16Wav(overlong, AUDIO_TARGET_SAMPLE_RATE)).toThrow(
      RangeError
    )
  })
})
