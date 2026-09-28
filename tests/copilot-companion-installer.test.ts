import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CopilotCompanionInstaller } from '../src/main/copilot-companion-installer'

const directories: string[] = []
const extensionName = 'excalidraw-visualizer-companion'
const manifest = `${JSON.stringify(
  {
    name: extensionName,
    version: 1,
    managedBy: 'com.excalidrawvisualizer.app'
  },
  null,
  2
)}\n`

const arrangeInstaller = async (
  entry = 'export const version = 1\n'
): Promise<{
  sourceDirectory: string
  targetDirectory: string
  installer: CopilotCompanionInstaller
}> => {
  const root = await mkdtemp(join(tmpdir(), 'excalidraw-companion-'))
  directories.push(root)
  const sourceDirectory = join(root, 'source')
  const copilotHome = join(root, 'copilot-home')
  const targetDirectory = join(copilotHome, 'extensions', extensionName)
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, 'extension.mjs'), entry)
  await writeFile(join(sourceDirectory, 'copilot-extension.json'), manifest)
  return {
    sourceDirectory,
    targetDirectory,
    installer: new CopilotCompanionInstaller(sourceDirectory, copilotHome)
  }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('CopilotCompanionInstaller', () => {
  it('installs the bundled extension into the user Copilot directory', async () => {
    const { installer, targetDirectory } = await arrangeInstaller()

    await expect(installer.getStatus()).resolves.toEqual({
      state: 'not-installed'
    })
    await expect(installer.install()).resolves.toEqual({
      status: { state: 'current' },
      restartRequired: true
    })
    await expect(installer.getStatus()).resolves.toEqual({ state: 'current' })
    await expect(
      readFile(join(targetDirectory, 'extension.mjs'), 'utf8')
    ).resolves.toBe('export const version = 1\n')
  })

  it('detects and installs a bundled update', async () => {
    const { installer, sourceDirectory, targetDirectory } =
      await arrangeInstaller()
    await installer.install()
    await writeFile(
      join(sourceDirectory, 'extension.mjs'),
      'export const version = 2\n'
    )

    await expect(installer.getStatus()).resolves.toEqual({
      state: 'update-available'
    })
    await installer.install()
    await expect(
      readFile(join(targetDirectory, 'extension.mjs'), 'utf8')
    ).resolves.toBe('export const version = 2\n')
  })

  it('refuses to overwrite an unmanaged extension', async () => {
    const { installer, targetDirectory } = await arrangeInstaller()
    await mkdir(targetDirectory, { recursive: true })
    await writeFile(
      join(targetDirectory, 'extension.mjs'),
      'export const custom = true\n'
    )

    await expect(installer.getStatus()).resolves.toEqual({ state: 'unmanaged' })
    await expect(installer.install()).rejects.toThrow(
      'not managed by Excalidraw Visualizer'
    )
    await expect(
      readFile(join(targetDirectory, 'extension.mjs'), 'utf8')
    ).resolves.toBe('export const custom = true\n')
  })
})
