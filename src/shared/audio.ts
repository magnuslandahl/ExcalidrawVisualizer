export const AUDIO_TARGET_SAMPLE_RATE = 16_000
export const MAX_AUDIO_DURATION_SECONDS = 5 * 60

const validateSampleRate = (sampleRate: number): void => {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('Sample rate must be a positive integer')
  }
}

const validatePcm = (samples: Float32Array, sampleRate: number): void => {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError('PCM samples must be a Float32Array')
  }
  validateSampleRate(sampleRate)
  if (samples.length === 0) {
    throw new RangeError('PCM samples must not be empty')
  }
  if (samples.length / sampleRate > MAX_AUDIO_DURATION_SECONDS) {
    throw new RangeError(`PCM duration must not exceed ${MAX_AUDIO_DURATION_SECONDS} seconds`)
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw new RangeError('PCM samples must all be finite')
    }
  }
}

export const downsampleMonoPcmTo16Khz = (
  samples: Float32Array,
  sourceSampleRate: number
): Float32Array => {
  validatePcm(samples, sourceSampleRate)
  if (sourceSampleRate < AUDIO_TARGET_SAMPLE_RATE) {
    throw new RangeError('Source sample rate must be at least 16000 Hz')
  }
  if (sourceSampleRate === AUDIO_TARGET_SAMPLE_RATE) {
    return samples.slice()
  }

  const outputLength = Math.max(
    1,
    Math.round((samples.length * AUDIO_TARGET_SAMPLE_RATE) / sourceSampleRate)
  )
  const output = new Float32Array(outputLength)
  const ratio = sourceSampleRate / AUDIO_TARGET_SAMPLE_RATE

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = outputIndex * ratio
    const end = Math.min((outputIndex + 1) * ratio, samples.length)
    const firstInputIndex = Math.floor(start)
    const lastInputIndex = Math.ceil(end)
    let weightedSum = 0
    let totalWeight = 0

    for (
      let inputIndex = firstInputIndex;
      inputIndex < lastInputIndex;
      inputIndex += 1
    ) {
      const overlap = Math.min(end, inputIndex + 1) - Math.max(start, inputIndex)
      if (overlap > 0) {
        weightedSum += (samples[inputIndex] ?? 0) * overlap
        totalWeight += overlap
      }
    }
    output[outputIndex] = totalWeight > 0 ? weightedSum / totalWeight : 0
  }

  return output
}

export const encodePcm16Wav = (
  samples: Float32Array,
  sampleRate = AUDIO_TARGET_SAMPLE_RATE
): ArrayBuffer => {
  validatePcm(samples, sampleRate)

  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    const pcm16 = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767)
    view.setInt16(44 + index * bytesPerSample, pcm16, true)
  }

  return buffer
}
