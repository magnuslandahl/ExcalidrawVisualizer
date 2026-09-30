import { chmod, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const atomicWriteFile = async (targetPath: string, content: string | Uint8Array): Promise<void> => {
  const directory = dirname(targetPath)
  const temporaryPath = join(directory, `.${basename(targetPath)}.${randomUUID()}.tmp`)
  let mode: number | undefined

  try {
    mode = (await stat(targetPath)).mode
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') {
      throw error
    }
  }

  const handle = await open(temporaryPath, 'wx', mode)
  try {
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, targetPath)
    if (mode !== undefined) {
      await chmod(targetPath, mode)
    }
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      const code = cleanupError instanceof Error && 'code' in cleanupError
        ? cleanupError.code
        : undefined
      if (code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'Unable to remove the temporary file')
      }
    }
    throw error
  }
}
