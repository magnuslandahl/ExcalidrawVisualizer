export const updateRepository = 'magnuslandahl/ExcalidrawVisualizer'
export const updateReleasePage = `https://github.com/${updateRepository}/releases/tag/latest`
export const updateReleaseApi = `https://api.github.com/repos/${updateRepository}/releases/tags/latest`
export const checksumsAssetName = 'SHA256SUMS.txt'
const assetApiPath = `/repos/${updateRepository}/releases/assets/`

export type ReleaseAsset = {
  id: number
  name: string
  size: number
}

export type ReleaseDescription = {
  id: number
  version: string
  pageUrl: string
  assets: ReleaseAsset[]
}

export type UpdateCandidate =
  | {
      available: false
      latestVersion: string
    }
  | {
      available: true
      installable: false
      latestVersion: string
      reason: string
    }
  | {
      available: true
      installable: true
      latestVersion: string
      asset: ReleaseAsset & { checksumAssetId: number }
    }

type ParsedVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string[] | null
}

export const parseVersion = (value: string): ParsedVersion | null => {
  const match = value
    .trim()
    .replace(/^v/i, '')
    .match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    )
  if (!match) {
    return null
  }
  const prerelease = match[4]?.split('.') ?? null
  if (
    prerelease?.some(
      (identifier) =>
        !identifier || (/^\d+$/.test(identifier) && /^0\d+/.test(identifier))
    )
  ) {
    return null
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

const comparePrereleaseIdentifiers = (left: string, right: string): number => {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    return left.length === right.length
      ? left.localeCompare(right)
      : left.length < right.length
        ? -1
        : 1
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1
  }
  return left.localeCompare(right)
}

export const compareVersions = (left: string, right: string): number => {
  const first = parseVersion(left)
  const second = parseVersion(right)
  if (!first && !second) {
    return 0
  }
  if (!first) {
    return -1
  }
  if (!second) {
    return 1
  }
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (first[part] !== second[part]) {
      return first[part] < second[part] ? -1 : 1
    }
  }
  if (!first.prerelease && !second.prerelease) {
    return 0
  }
  if (!first.prerelease) {
    return 1
  }
  if (!second.prerelease) {
    return -1
  }
  const identifierCount = Math.max(
    first.prerelease.length,
    second.prerelease.length
  )
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = first.prerelease[index]
    const rightIdentifier = second.prerelease[index]
    if (leftIdentifier === undefined) {
      return -1
    }
    if (rightIdentifier === undefined) {
      return 1
    }
    const comparison = comparePrereleaseIdentifiers(
      leftIdentifier,
      rightIdentifier
    )
    if (comparison !== 0) {
      return comparison
    }
  }
  return 0
}

export const releaseVersion = (name: string, tag: string): string => {
  const fromName = name.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1]
  return fromName ?? tag.replace(/^v/i, '')
}

export const isSafeGitHubId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0

export const isSafeAssetName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  !value.includes('\r') &&
  !value.includes('\n')

export const assetApiUrl = (id: number): string => {
  if (!isSafeGitHubId(id)) {
    throw new Error('The release asset has no immutable GitHub identity')
  }
  return `https://api.github.com${assetApiPath}${id}`
}

export const isTrustedAssetApiUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    const id = Number(url.pathname.slice(assetApiPath.length))
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.github.com' &&
      url.pathname === `${assetApiPath}${id}` &&
      !url.search &&
      !url.hash &&
      isSafeGitHubId(id)
    )
  } catch {
    return false
  }
}

const assetPatterns = (
  platform: string,
  architecture: string
): RegExp[] => {
  if (platform === 'win32' && architecture === 'x64') {
    return [/^ExcalidrawVisualizer-Windows-x64-Setup\.exe$/i]
  }
  if (platform === 'darwin' && architecture === 'arm64') {
    return [/^ExcalidrawVisualizer-macOS-arm64\.dmg$/i]
  }
  if (platform === 'darwin' && architecture === 'x64') {
    return [/^ExcalidrawVisualizer-macOS-x64\.dmg$/i]
  }
  return []
}

export const pickUpdateAsset = (
  assets: readonly ReleaseAsset[],
  platform: string,
  architecture: string
): ReleaseAsset | null => {
  for (const pattern of assetPatterns(platform, architecture)) {
    const asset = assets.find((candidate) => pattern.test(candidate.name))
    if (asset) {
      return asset
    }
  }
  return null
}

export const describeUpdate = (
  currentVersion: string,
  release: ReleaseDescription,
  platform: string,
  architecture: string
): UpdateCandidate => {
  if (compareVersions(release.version, currentVersion) <= 0) {
    return { available: false, latestVersion: release.version }
  }

  const asset = pickUpdateAsset(release.assets, platform, architecture)
  const checksumAssets = release.assets.filter(
    (candidate) => candidate.name === checksumsAssetName
  )
  if (!asset) {
    return {
      available: true,
      installable: false,
      latestVersion: release.version,
      reason: 'That release has no download for this computer.'
    }
  }
  if (
    checksumAssets.length !== 1 ||
    !isSafeGitHubId(release.id) ||
    !isSafeGitHubId(asset.id) ||
    !isSafeGitHubId(checksumAssets[0]?.id) ||
    !isSafeAssetName(asset.name) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  ) {
    return {
      available: true,
      installable: false,
      latestVersion: release.version,
      reason:
        'That release cannot be installed because its download checksums are missing or untrusted.'
    }
  }

  return {
    available: true,
    installable: true,
    latestVersion: release.version,
    asset: {
      ...asset,
      checksumAssetId: checksumAssets[0].id
    }
  }
}
