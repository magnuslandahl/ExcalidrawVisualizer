import { createHash } from 'node:crypto'

export const fingerprint = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex')
