import { describe, expect, it, vi } from 'vitest'
import {
  listMicrophones,
  microphoneConstraints,
  microphoneError,
  microphoneLevel
} from '../src/renderer/src/microphones'

describe('microphone selection', () => {
  it('uses the system default only when no specific input is selected', () => {
    expect(microphoneConstraints('')).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false
    })
    expect(microphoneConstraints('usb-microphone')).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: 'usb-microphone' }
      },
      video: false
    })
  })

  it('lists audio inputs without opening the microphone automatically', async () => {
    const devices = {
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' },
        { kind: 'audioinput', deviceId: 'anonymous', label: '' },
        { kind: 'audioinput', deviceId: '', label: '' },
        { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
        { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' }
      ]),
      getUserMedia: vi.fn()
    }
    expect(await listMicrophones(devices)).toEqual([
      { deviceId: 'usb', label: 'USB microphone' },
      { deviceId: 'anonymous', label: 'Microphone 2' }
    ])
    expect(devices.getUserMedia).not.toHaveBeenCalled()
  })

  it.each([false, true])('stops explicit discovery capture even when enumeration fails: %s', async (fails) => {
    const stop = vi.fn()
    const devices = {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
      enumerateDevices: fails
        ? vi.fn().mockRejectedValue(new Error('Enumeration failed'))
        : vi.fn().mockResolvedValue([])
    }
    if (fails) {
      await expect(listMicrophones(devices, true)).rejects.toThrow('Enumeration failed')
    } else {
      expect(await listMicrophones(devices, true)).toEqual([])
    }
    expect(devices.getUserMedia).toHaveBeenCalledWith(microphoneConstraints(''))
    expect(stop).toHaveBeenCalledOnce()
  })

  it.each([
    ['NotAllowedError', 'Microphone access was denied'],
    ['OverconstrainedError', 'selected microphone is unavailable'],
    ['NotFoundError', 'selected microphone is unavailable'],
    ['NotReadableError', 'in use exclusively'],
    ['AbortError', 'in use exclusively']
  ])('explains %s without silently changing the selected microphone', (name, message) => {
    expect(microphoneError(new DOMException('Capture failed', name))).toContain(message)
  })

  it('keeps an unexpected capture error visible', () => {
    expect(microphoneError(new Error('Audio engine failed'))).toContain('Audio engine failed')
    expect(microphoneError('Device failed')).toContain('Device failed')
  })

  it('measures both polarities and clamps the input meter', () => {
    expect(microphoneLevel(new Float32Array())).toBe(0)
    expect(microphoneLevel(new Float32Array([0, -0.5, 0.25]))).toBe(0.5)
    expect(microphoneLevel(new Float32Array([-2]))).toBe(1)
  })
})
