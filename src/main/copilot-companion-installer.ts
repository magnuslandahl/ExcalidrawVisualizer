import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import type {
  CopilotCompanionInstallResult,
  CopilotCompanionStatus
} from '../shared/contracts'

const extensionName = 'excalidraw-visualizer-companion'
const manifestName = 'copilot-extension.json'
const entryName = 'extension.mjs'
const managedBy = 'com.excalidrawvisualizer.app'

type CompanionManifest = {
  name: string
  version: number
  managedBy: string
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const readOptionalFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

const parseManifest = (content: string): CompanionManifest | null => {
  try {
    const value: unknown = JSON.parse(content)
    if (
      !value ||
      typeof value !== 'object' ||
      !('name' in value) ||
      value.name !== extensionName ||
      !('version' in value) ||
      value.version !== 1 ||
      !('managedBy' in value) ||
      value.managedBy !== managedBy
    ) {
      return null
    }
    return value as CompanionManifest
  } catch {
    return null
  }
}

export class CopilotCompanionInstaller {
  readonly #sourceDirectory: string
  readonly #targetDirectory: string

  constructor(sourceDirectory: string, copilotHome: string) {
    this.#sourceDirectory = sourceDirectory
    this.#targetDirectory = join(copilotHome, 'extensions', extensionName)
  }

  async getStatus(): Promise<CopilotCompanionStatus> {
    const bundled = await this.#readBundledFiles()
    let target
    try {
      target = await lstat(this.#targetDirectory)
    } catch (error) {
      if (isMissing(error)) {
        return { state: 'not-installed' }
      }
      throw error
    }

    if (!target.isDirectory() || target.isSymbolicLink()) {
      return { state: 'unmanaged' }
    }

    const installedManifest = await readOptionalFile(
      join(this.#targetDirectory, manifestName)
    )
    if (installedManifest === null) {
      const entries = await readdir(this.#targetDirectory)
      return { state: entries.length === 0 ? 'not-installed' : 'unmanaged' }
    }
    if (!parseManifest(installedManifest)) {
      return { state: 'unmanaged' }
    }

    const installedEntry = await readOptionalFile(
      join(this.#targetDirectory, entryName)
    )
    return {
      state:
        installedEntry === bundled.entry &&
        installedManifest === bundled.manifest
          ? 'current'
          : 'update-available'
    }
  }

  async install(): Promise<CopilotCompanionInstallResult> {
    const status = await this.getStatus()
    if (status.state === 'unmanaged') {
      throw new Error(
        'A companion extension not managed by Excalidraw Visualizer already exists. Remove or rename it before installing.'
      )
    }

    const bundled = await this.#readBundledFiles()
    await mkdir(this.#targetDirectory, { recursive: true, mode: 0o700 })
    await atomicWriteFile(join(this.#targetDirectory, entryName), bundled.entry)
    await atomicWriteFile(
      join(this.#targetDirectory, manifestName),
      bundled.manifest
    )
    return {
      status: { state: 'current' },
      restartRequired: true
    }
  }

  async #readBundledFiles(): Promise<{
    entry: string
    manifest: string
  }> {
    let bundled: [string, string]
    try {
      bundled = await Promise.all([
        readFile(join(this.#sourceDirectory, entryName), 'utf8'),
        readFile(join(this.#sourceDirectory, manifestName), 'utf8')
      ])
    } catch (error) {
      throw new Error('The bundled Copilot companion is unavailable', {
        cause: error
      })
    }
    const [entry, manifest] = bundled
    if (!parseManifest(manifest)) {
      throw new Error('The bundled Copilot companion manifest is invalid')
    }
    return { entry, manifest }
  }
}
