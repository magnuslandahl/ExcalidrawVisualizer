import { describe, expect, it } from 'vitest'
import { ContentFingerprintTracker } from '../src/main/fingerprint-tracker'

describe('ContentFingerprintTracker', () => {
  it('suppresses application write echoes by content hash', () => {
    const tracker = new ContentFingerprintTracker('initial')
    tracker.markOwnWrite('saved-content')

    expect(tracker.shouldSuppress('saved-content')).toBe(true)
    expect(tracker.shouldSuppress('saved-content')).toBe(true)
    expect(tracker.shouldSuppress('external-content')).toBe(false)
  })
})
