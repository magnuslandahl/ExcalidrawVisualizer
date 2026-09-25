import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type RecentFileData = {
  paths: string[]
}

export class RecentFiles {
  readonly #storagePath: string
  #paths: string[] = []

  constructor(storagePath: string) {
    this.#storagePath = storagePath
  }

  get paths(): readonly string[] {
    return this.#paths
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#storagePath, 'utf8')) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'paths' in parsed &&
        Array.isArray(parsed.paths)
      ) {
        this.#paths = parsed.paths
          .filter((path): path is string => typeof path === 'string')
          .slice(0, 10)
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error
      }
    }
  }

  async add(path: string): Promise<void> {
    this.#paths = [path, ...this.#paths.filter((item) => item !== path)].slice(0, 10)
    await mkdir(dirname(this.#storagePath), { recursive: true })
    const data: RecentFileData = { paths: this.#paths }
    await writeFile(this.#storagePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }
}
