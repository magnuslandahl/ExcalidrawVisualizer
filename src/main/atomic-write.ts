import { chmod, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const atomicWriteFile = async (targetPath: string, content: string): Promise<void> => {
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
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temporaryPath, targetPath)
    if (mode !== undefined) {
      await chmod(targetPath, mode)
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}
