import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'

const sha256Pattern = /^[a-f0-9]{64}$/i

export const expectedChecksum = (
  manifest: string,
  assetName: string
): string => {
  if (!assetName || /[\\/\r\n]/.test(assetName)) {
    throw new Error('The selected update has an invalid asset name')
  }
  const matches = manifest
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64}) [ *](.+)$/i)
      if (!match?.[1] || !match[2]) {
        throw new Error('SHA256SUMS.txt contains a malformed entry')
      }
      return {
        checksum: match[1].toLowerCase(),
        name: match[2].startsWith('./') ? match[2].slice(2) : match[2]
      }
    })
    .filter((entry) => entry.name === assetName)

  if (matches.length === 0) {
    throw new Error(`SHA256SUMS.txt has no checksum for ${assetName}`)
  }
  if (matches.length !== 1) {
    throw new Error(`SHA256SUMS.txt has duplicate checksums for ${assetName}`)
  }
  const match = matches[0]
  if (!match) {
    throw new Error(`SHA256SUMS.txt has no checksum for ${assetName}`)
  }
  return match.checksum
}

export const checksumsEqual = (left: string, right: string): boolean => {
  if (!sha256Pattern.test(left) || !sha256Pattern.test(right)) {
    return false
  }
  const first = Buffer.from(left.toLowerCase(), 'hex')
  const second = Buffer.from(right.toLowerCase(), 'hex')
  return first.length === second.length && timingSafeEqual(first, second)
}

export const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
