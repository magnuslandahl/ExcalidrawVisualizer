import { describe, expect, it } from 'vitest'
import {
  checksumsEqual,
  expectedChecksum
} from '../src/main/update-checksums'

const checksum = 'a'.repeat(64)

describe('update checksums', () => {
  it('finds the exact release asset checksum', () => {
    expect(
      expectedChecksum(
        `${checksum}  ./ExcalidrawVisualizer-macOS-arm64.dmg\n`,
        'ExcalidrawVisualizer-macOS-arm64.dmg'
      )
    ).toBe(checksum)
  })

  it('rejects missing, duplicate, and malformed entries', () => {
    expect(() => expectedChecksum(`${checksum}  other.dmg\n`, 'app.dmg')).toThrow(
      'no checksum'
    )
    expect(() =>
      expectedChecksum(`${checksum}  app.dmg\n${checksum}  app.dmg\n`, 'app.dmg')
    ).toThrow('duplicate checksums')
    expect(() => expectedChecksum('not-a-checksum app.dmg\n', 'app.dmg')).toThrow(
      'malformed entry'
    )
  })

  it('compares valid checksums without accepting malformed values', () => {
    expect(checksumsEqual(checksum, checksum.toUpperCase())).toBe(true)
    expect(checksumsEqual(checksum, 'b'.repeat(64))).toBe(false)
    expect(checksumsEqual(checksum, 'invalid')).toBe(false)
  })
})
