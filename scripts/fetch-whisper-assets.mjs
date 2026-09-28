import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const vendorRoot = join(root, 'vendor', 'whisper')
const modelRoot = join(vendorRoot, 'models')
const whisperTag = 'b4938'
const whisperCommit = '371b5a7561823ab2bb32142d2751e35e7534727b'

const assets = {
  model: {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin',
    path: join(modelRoot, 'ggml-small.bin'),
    size: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
  },
  vad: {
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin',
    path: join(modelRoot, 'ggml-silero-v5.1.2.bin'),
    size: 885_098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
  },
  windows: {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${whisperTag}/whisper-bin-x64.zip`,
    size: 8_361_840,
    sha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d'
  }
}

const sha256File = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

const verifyFile = async (path, expected) => {
  try {
    const metadata = await stat(path)
    return (
      metadata.isFile() &&
      metadata.size === expected.size &&
      (await sha256File(path)) === expected.sha256
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const download = async (asset) => {
  await mkdir(dirname(asset.path), { recursive: true })
  if (await verifyFile(asset.path, asset)) {
    return
  }

  await rm(asset.path, { force: true })
  const partialPath = `${asset.path}.part`
  await rm(partialPath, { force: true })

  try {
    const response = await fetch(asset.url, { redirect: 'follow' })
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download ${asset.url}: HTTP ${response.status}`)
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(partialPath, { flags: 'wx', mode: 0o600 })
    )
    if (!(await verifyFile(partialPath, asset))) {
      throw new Error(`Downloaded asset failed verification: ${basename(asset.path)}`)
    }
    await rename(partialPath, asset.path)
  } catch (error) {
    await rm(partialPath, { force: true })
    await rm(asset.path, { force: true })
    throw error
  }
}

const findWindowsTar = () => {
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  return join(windowsDirectory, 'System32', 'tar.exe')
}

const installWindowsBinary = async () => {
  const archive = join(vendorRoot, 'cache', `whisper-bin-${whisperTag}-x64.zip`)
  const destination = join(vendorRoot, 'bin', 'windows-x64')
  await mkdir(dirname(destination), { recursive: true })
  const temporary = await mkdtemp(
    join(dirname(destination), '.windows-x64-install-')
  )
  try {
    await download({ ...assets.windows, path: archive })
    await execFileAsync(findWindowsTar(), ['-xf', archive, '-C', temporary])
    await stat(join(temporary, 'Release', 'whisper-cli.exe'))
    await stat(join(temporary, 'Release', 'whisper.dll'))
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
}

const installMacBinary = async () => {
  const destination = join(vendorRoot, 'bin', 'macos-universal', 'whisper-cli')
  const sourceRoot = await mkdtemp(join(tmpdir(), 'excalidraw-whisper-source-'))
  const buildRoot = join(sourceRoot, 'build')
  try {
    await execFileAsync('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      whisperTag,
      'https://github.com/ggml-org/whisper.cpp',
      sourceRoot
    ])
    const { stdout } = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])
    if (stdout.trim() !== whisperCommit) {
      throw new Error(`whisper.cpp ${whisperTag} resolved to an unexpected commit`)
    }

    await execFileAsync('cmake', [
      '-S',
      sourceRoot,
      '-B',
      buildRoot,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64',
      '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF',
      '-DGGML_OPENMP=OFF',
      '-DGGML_METAL=ON',
      '-DGGML_METAL_EMBED_LIBRARY=ON',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON'
    ])
    await execFileAsync('cmake', [
      '--build',
      buildRoot,
      '--config',
      'Release',
      '--target',
      'whisper-cli',
      '--parallel'
    ])

    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(buildRoot, 'bin', 'whisper-cli'), destination)
    await chmod(destination, 0o755)
    const { stdout: architectures } = await execFileAsync('lipo', [
      '-archs',
      destination
    ])
    const packagedArchitectures = new Set(architectures.trim().split(/\s+/))
    if (
      !packagedArchitectures.has('arm64') ||
      !packagedArchitectures.has('x86_64') ||
      packagedArchitectures.size !== 2
    ) {
      throw new Error('The macOS whisper-cli build is not universal arm64/x86_64')
    }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
  }
}

await Promise.all([download(assets.model), download(assets.vad)])

if (process.platform === 'win32' && process.arch === 'x64') {
  await installWindowsBinary()
} else if (process.platform === 'darwin') {
  await installMacBinary()
} else {
  throw new Error(
    `Whisper packaging is unsupported on ${process.platform}-${process.arch}`
  )
}
