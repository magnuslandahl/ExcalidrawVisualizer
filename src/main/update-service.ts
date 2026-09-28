import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  accessSync,
  constants,
  createWriteStream,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, net, shell } from 'electron'
import {
  assetApiUrl,
  checksumsAssetName,
  describeUpdate,
  isSafeAssetName,
  isSafeGitHubId,
  isTrustedAssetApiUrl,
  parseVersion,
  releaseVersion,
  updateReleaseApi,
  type ReleaseAsset,
  type ReleaseDescription
} from '../shared/updates'
import type {
  UpdateAssetReference,
  UpdateCheckResult,
  UpdateInstallResult
} from '../shared/contracts'
import {
  checksumsEqual,
  expectedChecksum,
  hashFile
} from './update-checksums'

const requestTimeoutMs = 20_000
const maximumMetadataBytes = 1024 * 1024

type PendingUpdate = {
  selectionId: string
  releaseId: number
  assetId: number
  checksumAssetId: number
  name: string
  size: number
  expectedSha256: string
  installing: boolean
}

type GitHubReleasePayload = {
  id: number
  name: string
  tagName: string
  pageUrl: string
  assets: ReleaseAsset[]
}

type PrepareToQuit = () => () => void

const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const parseReleasePayload = (value: unknown): GitHubReleasePayload => {
  if (!value || typeof value !== 'object') {
    throw new Error('The update server returned an invalid release')
  }
  const candidate = value as Record<string, unknown>
  if (
    !isSafeGitHubId(candidate.id) ||
    typeof candidate.name !== 'string' ||
    typeof candidate.tag_name !== 'string' ||
    typeof candidate.html_url !== 'string' ||
    !Array.isArray(candidate.assets)
  ) {
    throw new Error('The update server returned an incomplete release')
  }
  const assets = candidate.assets.map((asset) => {
    if (!asset || typeof asset !== 'object') {
      throw new Error('The update server returned an invalid release asset')
    }
    const item = asset as Record<string, unknown>
    if (
      !isSafeGitHubId(item.id) ||
      !isSafeAssetName(item.name) ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) <= 0
    ) {
      throw new Error('The update server returned an invalid release asset')
    }
    return {
      id: item.id,
      name: item.name,
      size: Number(item.size)
    }
  })
  return {
    id: candidate.id,
    name: candidate.name,
    tagName: candidate.tag_name,
    pageUrl: candidate.html_url,
    assets
  }
}

const macArchitecture = (): string => {
  if (process.arch === 'arm64') {
    return 'arm64'
  }
  try {
    const translated = execFileSync(
      '/usr/sbin/sysctl',
      ['-in', 'sysctl.proc_translated'],
      { encoding: 'utf8', timeout: 2_000 }
    ).trim()
    return translated === '1' ? 'arm64' : 'x64'
  } catch {
    return 'x64'
  }
}

const currentArchitecture = (): string =>
  process.platform === 'darwin' ? macArchitecture() : process.arch

const getBuffer = (
  url: string,
  accept: string,
  maximumBytes = maximumMetadataBytes
): Promise<Buffer> =>
  new Promise((resolveRequest, rejectRequest) => {
    const request = net.request({ url, method: 'GET', redirect: 'follow' })
    request.setHeader('Accept', accept)
    request.setHeader('User-Agent', `ExcalidrawVisualizer/${app.getVersion()}`)
    const timer = setTimeout(() => {
      request.abort()
      rejectRequest(new Error('The update server did not answer in time'))
    }, requestTimeoutMs)

    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maximumBytes) {
          request.abort()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        clearTimeout(timer)
        if (bytes > maximumBytes) {
          rejectRequest(new Error('The update response was unexpectedly large'))
          return
        }
        if (response.statusCode === 403) {
          rejectRequest(
            new Error('GitHub is rate-limiting this computer. Try again later.')
          )
          return
        }
        if (response.statusCode !== 200) {
          rejectRequest(
            new Error(`The update server answered ${response.statusCode}`)
          )
          return
        }
        resolveRequest(Buffer.concat(chunks))
      })
      response.on('error', (error: Error) => {
        clearTimeout(timer)
        rejectRequest(error)
      })
    })
    request.on('error', (error: Error) => {
      clearTimeout(timer)
      rejectRequest(error)
    })
    request.end()
  })

const getRelease = async (): Promise<ReleaseDescription> => {
  let value: unknown
  try {
    value = JSON.parse(
      (await getBuffer(updateReleaseApi, 'application/vnd.github+json')).toString(
        'utf8'
      )
    )
  } catch (error) {
    throw new Error(`Could not read the latest release: ${messageFromError(error)}`)
  }
  const payload = parseReleasePayload(value)
  const version = releaseVersion(payload.name, payload.tagName)
  if (!parseVersion(version)) {
    throw new Error('The latest release has no valid version')
  }
  return {
    id: payload.id,
    version,
    pageUrl: payload.pageUrl,
    assets: payload.assets
  }
}

const download = async (
  selected: PendingUpdate,
  target: string,
  onProgress: (progress: number) => void
): Promise<void> => {
  const url = assetApiUrl(selected.assetId)
  if (!isTrustedAssetApiUrl(url)) {
    throw new Error('The selected update does not have a trusted download URL')
  }
  const partial = `${target}.part`
  await Promise.all([
    rm(target, { force: true }),
    rm(partial, { force: true })
  ])

  await new Promise<void>((resolveRequest, rejectRequest) => {
    const request = net.request({ url, method: 'GET', redirect: 'follow' })
    request.setHeader('Accept', 'application/octet-stream')
    request.setHeader('User-Agent', `ExcalidrawVisualizer/${app.getVersion()}`)
    const timer = setTimeout(() => {
      request.abort()
      rejectRequest(new Error('The update download did not start in time'))
    }, requestTimeoutMs)

    request.on('response', (response) => {
      clearTimeout(timer)
      if (response.statusCode !== 200) {
        rejectRequest(
          new Error(`The update download answered ${response.statusCode}`)
        )
        return
      }

      let received = 0
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          if (received > selected.size) {
            callback(new Error('The update download exceeded its expected size'))
            return
          }
          onProgress(received / selected.size)
          callback(null, chunk)
        }
      })
      // Electron's declaration exposes events only, although the runtime object
      // is the Node readable stream accepted by pipeline.
      const source = response as unknown as Readable
      void pipeline(
        source,
        progress,
        createWriteStream(partial, { flags: 'wx' })
      )
        .then(async () => {
          if (received !== selected.size) {
            throw new Error('The update download stopped before it was complete')
          }
          const actual = await hashFile(partial)
          if (!checksumsEqual(actual, selected.expectedSha256)) {
            throw new Error(
              `The checksum for ${selected.name} did not match SHA256SUMS.txt`
            )
          }
          await rm(target, { force: true })
          await rename(partial, target)
          resolveRequest()
        })
        .catch(async (error: unknown) => {
          await Promise.all([
            rm(target, { force: true }),
            rm(partial, { force: true })
          ])
          rejectRequest(error)
        })
    })
    request.on('error', (error: Error) => {
      clearTimeout(timer)
      void Promise.all([
        rm(target, { force: true }),
        rm(partial, { force: true })
      ]).finally(() => rejectRequest(error))
    })
    request.end()
  })
}

const macAppBundle = (): string | null => {
  if (!app.isPackaged) {
    return null
  }
  const bundle = resolve(dirname(app.getPath('exe')), '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

const canReplaceMacApp = (): boolean => {
  const bundle = macAppBundle()
  if (!bundle) {
    return false
  }
  try {
    accessSync(bundle, constants.W_OK)
    accessSync(dirname(bundle), constants.W_OK)
    return true
  } catch {
    return false
  }
}

const canInstallInPlace = (): boolean => {
  if (process.platform === 'win32') {
    return app.isPackaged
  }
  return process.platform === 'darwin' && canReplaceMacApp()
}

const unmountImage = (mountPoint: string): void => {
  try {
    execFileSync(
      '/usr/bin/hdiutil',
      ['detach', mountPoint, '-force'],
      { stdio: 'ignore', timeout: 60_000 }
    )
  } catch {
    // The mount may already be gone.
  }
  try {
    rmSync(mountPoint, { recursive: true, force: true })
  } catch {
    // A mount that could not be detached remains owned by macOS.
  }
}

const stageMacUpdate = (dmgPath: string): {
  bundle: string
  staged: string
} => {
  const bundle = macAppBundle()
  if (!bundle) {
    throw new Error('This copy is not an installed application')
  }
  const mountPoint = mkdtempSync(join(tmpdir(), 'excalidraw-update-'))
  const staged = join(
    dirname(bundle),
    `.${basename(bundle)}.${randomUUID()}.new`
  )

  try {
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'attach',
        dmgPath,
        '-nobrowse',
        '-readonly',
        '-noautoopen',
        '-mountpoint',
        mountPoint
      ],
      { stdio: 'ignore', timeout: 120_000 }
    )
    const entry = readdirSync(mountPoint).find((name) => name.endsWith('.app'))
    if (!entry) {
      throw new Error('The disk image contains no application')
    }
    const candidate = join(mountPoint, entry)
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate], {
      stdio: 'ignore',
      timeout: 120_000
    })
    const identifier = execFileSync(
      '/usr/bin/defaults',
      ['read', join(candidate, 'Contents', 'Info'), 'CFBundleIdentifier'],
      { encoding: 'utf8', timeout: 20_000 }
    ).trim()
    if (identifier !== 'com.excalidrawvisualizer.app') {
      throw new Error(
        `The downloaded application is ${identifier}, not Excalidraw Visualizer`
      )
    }
    rmSync(staged, { recursive: true, force: true })
    execFileSync('/usr/bin/ditto', [candidate, staged], {
      timeout: 300_000
    })
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    unmountImage(mountPoint)
    throw error
  }

  unmountImage(mountPoint)
  return { bundle, staged }
}

const waitForSpawn = (child: ChildProcess): Promise<void> =>
  new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn)
    child.once('error', rejectSpawn)
  })

const openDownloadedUpdate = async (path: string): Promise<void> => {
  const error = await shell.openPath(path)
  if (error) {
    throw new Error(error)
  }
}

const launchMacSwap = async (
  bundle: string,
  staged: string,
  prepareToQuit: PrepareToQuit
): Promise<void> => {
  const script = join(tmpdir(), `excalidraw-swap-${process.pid}.sh`)
  const backup = `${bundle}.update-backup`
  writeFileSync(
    script,
    `#!/bin/sh
APP=$1
NEW=$2
OLD=$3
PID=$4
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    /bin/rm -rf "$NEW"
    /bin/rm -f "$0"
    exit 1
  fi
  /bin/sleep 0.1
done
/bin/rm -rf "$OLD"
/bin/mv "$APP" "$OLD" || exit 1
if ! /bin/mv "$NEW" "$APP"; then
  /bin/mv "$OLD" "$APP"
  exit 1
fi
/bin/rm -rf "$OLD"
/usr/bin/open "$APP"
/bin/rm -f "$0"
`,
    { encoding: 'utf8', mode: 0o700 }
  )

  let rollback: (() => void) | undefined
  try {
    rollback = prepareToQuit()
    const child = spawn(
      '/bin/sh',
      [script, bundle, staged, backup, String(process.pid)],
      { detached: true, stdio: 'ignore' }
    )
    await waitForSpawn(child)
    child.unref()
  } catch (error) {
    rollback?.()
    rmSync(script, { force: true })
    rmSync(staged, { recursive: true, force: true })
    throw error
  }
  setTimeout(() => app.quit(), 800)
}

export class UpdateService {
  #pending: PendingUpdate | null = null

  async check(): Promise<UpdateCheckResult> {
    this.#pending = null
    const currentVersion = app.getVersion()
    let release: ReleaseDescription
    try {
      release = await getRelease()
    } catch (error) {
      return {
        checked: false,
        currentVersion,
        available: false,
        installable: false,
        latestVersion: null,
        reason: messageFromError(error),
        asset: null,
        inPlace: false
      }
    }

    const description = describeUpdate(
      currentVersion,
      release,
      process.platform,
      currentArchitecture()
    )
    if (!description.available) {
      return {
        checked: true,
        currentVersion,
        available: false,
        installable: false,
        latestVersion: description.latestVersion,
        reason: null,
        asset: null,
        inPlace: false
      }
    }
    if (!description.installable) {
      return {
        checked: true,
        currentVersion,
        available: true,
        installable: false,
        latestVersion: description.latestVersion,
        reason: description.reason,
        asset: null,
        inPlace: false
      }
    }
    if (!app.isPackaged) {
      return {
        checked: true,
        currentVersion,
        available: true,
        installable: false,
        latestVersion: description.latestVersion,
        reason: 'Automatic updates are available only in a packaged application.',
        asset: null,
        inPlace: false
      }
    }

    try {
      const checksumManifest = (
        await getBuffer(
          assetApiUrl(description.asset.checksumAssetId),
          'application/octet-stream'
        )
      ).toString('utf8')
      const expectedSha256 = expectedChecksum(
        checksumManifest,
        description.asset.name
      )
      this.#pending = {
        selectionId: randomUUID(),
        releaseId: release.id,
        assetId: description.asset.id,
        checksumAssetId: description.asset.checksumAssetId,
        name: description.asset.name,
        size: description.asset.size,
        expectedSha256,
        installing: false
      }
      return {
        checked: true,
        currentVersion,
        available: true,
        installable: true,
        latestVersion: description.latestVersion,
        reason: null,
        asset: this.#publicReference(this.#pending),
        inPlace: canInstallInPlace()
      }
    } catch (error) {
      return {
        checked: true,
        currentVersion,
        available: true,
        installable: false,
        latestVersion: description.latestVersion,
        reason: `The update checksum could not be verified: ${messageFromError(error)}`,
        asset: null,
        inPlace: false
      }
    }
  }

  async install(
    reference: unknown,
    onProgress: (progress: number) => void,
    prepareToQuit: PrepareToQuit
  ): Promise<UpdateInstallResult> {
    const selected = this.#resolveReference(reference)
    selected.installing = true
    const target = join(tmpdir(), `${randomUUID()}-${selected.name}`)

    try {
      const release = await getRelease()
      this.#validateCurrentRelease(selected, release)
      await download(selected, target, onProgress)

      if (process.platform === 'darwin') {
        if (!canInstallInPlace()) {
          await openDownloadedUpdate(target)
          this.#pending = null
          return {
            installed: false,
            opened: true,
            message:
              'The update was downloaded and opened because this application cannot replace itself.'
          }
        }
        let staged
        try {
          staged = stageMacUpdate(target)
        } catch (error) {
          await openDownloadedUpdate(target)
          this.#pending = null
          return {
            installed: false,
            opened: true,
            message: `The update was downloaded and opened instead: ${messageFromError(error)}`
          }
        }
        await rm(target, { force: true })
        await launchMacSwap(staged.bundle, staged.staged, prepareToQuit)
        this.#pending = null
        return { installed: true, opened: false, message: null }
      }

      if (process.platform === 'win32' && app.isPackaged) {
        const rollback = prepareToQuit()
        try {
          const child = spawn(target, ['/S', '--force-run'], {
            detached: true,
            stdio: 'ignore'
          })
          await waitForSpawn(child)
          child.unref()
        } catch (error) {
          rollback()
          throw error
        }
        setTimeout(() => app.quit(), 1_200)
        this.#pending = null
        return { installed: true, opened: false, message: null }
      }

      await openDownloadedUpdate(target)
      this.#pending = null
      return {
        installed: false,
        opened: true,
        message: 'The update was downloaded and opened.'
      }
    } catch (error) {
      this.#pending = null
      await rm(target, { force: true })
      throw new Error(
        `${messageFromError(error)} Check for updates again before retrying.`
      )
    }
  }

  #publicReference(update: PendingUpdate): UpdateAssetReference {
    return {
      selectionId: update.selectionId,
      name: update.name,
      size: update.size
    }
  }

  #resolveReference(value: unknown): PendingUpdate {
    if (!value || typeof value !== 'object' || !this.#pending) {
      throw new Error(
        'The selected update is no longer valid. Check for updates again.'
      )
    }
    const candidate = value as Record<string, unknown>
    if (
      this.#pending.installing ||
      Object.keys(candidate).sort().join(',') !== 'name,selectionId,size' ||
      candidate.selectionId !== this.#pending.selectionId ||
      candidate.name !== this.#pending.name ||
      candidate.size !== this.#pending.size
    ) {
      throw new Error(
        'The selected update is no longer valid. Check for updates again.'
      )
    }
    return this.#pending
  }

  #validateCurrentRelease(
    selected: PendingUpdate,
    release: ReleaseDescription
  ): void {
    const installer = release.assets.find(
      (asset) => asset.id === selected.assetId
    )
    const checksum = release.assets.find(
      (asset) => asset.id === selected.checksumAssetId
    )
    if (
      release.id !== selected.releaseId ||
      installer?.name !== selected.name ||
      installer.size !== selected.size ||
      checksum?.name !== checksumsAssetName
    ) {
      throw new Error('The checked release changed or disappeared.')
    }
  }
}
