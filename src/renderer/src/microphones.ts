export type MicrophoneInput = {
  deviceId: string
  label: string
}

export const microphoneConstraints = (deviceId: string): MediaStreamConstraints => ({
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
  },
  video: false
})

export const listMicrophones = async (
  devices: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>,
  requestAccess = false
): Promise<MicrophoneInput[]> => {
  let stream: MediaStream | undefined
  try {
    if (requestAccess) {
      stream = await devices.getUserMedia(microphoneConstraints(''))
    }
    const inputs = (await devices.enumerateDevices()).filter(
      (device) => device.kind === 'audioinput' && device.deviceId !== ''
    )
    return inputs.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`
    }))
  } finally {
    stream?.getTracks().forEach((track) => track.stop())
  }
}

export const microphoneError = (error: unknown): string => {
  if (error instanceof Error || error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access was denied. Allow microphone access for this app in Windows Settings > Privacy & security > Microphone, or macOS System Settings > Privacy & Security > Microphone.'
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'The selected microphone is unavailable. Connect it, refresh the microphone list, or choose another input.'
    }
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return 'The microphone could not be opened. Check that it is connected and not in use exclusively by another app.'
    }
    return `Microphone access failed: ${error.message}`
  }
  return `Microphone access failed: ${String(error)}`
}

export const microphoneLevel = (samples: Float32Array): number => {
  let peak = 0
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample))
  }
  return Math.min(1, peak)
}
