import { describe, expect, it } from 'vitest'
import {
  assetApiUrl,
  compareVersions,
  describeUpdate,
  isTrustedAssetApiUrl,
  pickUpdateAsset,
  releaseVersion,
  type ReleaseAsset
} from '../src/shared/updates'

const assets: ReleaseAsset[] = [
  {
    id: 11,
    name: 'ExcalidrawVisualizer-macOS-arm64.dmg',
    size: 100
  },
  {
    id: 12,
    name: 'ExcalidrawVisualizer-macOS-x64.dmg',
    size: 100
  },
  {
    id: 13,
    name: 'ExcalidrawVisualizer-Windows-x64-Portable.exe',
    size: 100
  },
  {
    id: 14,
    name: 'ExcalidrawVisualizer-Windows-x64-Setup.exe',
    size: 100
  },
  { id: 15, name: 'SHA256SUMS.txt', size: 100 }
]

describe('updates', () => {
  it('orders semantic versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.alpha')).toBe(-1)
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1)
    expect(compareVersions('1.0.0-invalid..value', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0trailing', '1.0.0')).toBe(-1)
  })

  it('reads the version from rolling release titles', () => {
    expect(
      releaseVersion('Excalidraw Visualizer 0.5.0 (build 12)', 'latest')
    ).toBe('0.5.0')
    expect(releaseVersion('Permanent release', 'v1.2.3')).toBe('1.2.3')
  })

  it('selects only the installable asset for the current computer', () => {
    expect(pickUpdateAsset(assets, 'darwin', 'arm64')?.id).toBe(11)
    expect(pickUpdateAsset(assets, 'darwin', 'x64')?.id).toBe(12)
    expect(pickUpdateAsset(assets, 'win32', 'x64')?.id).toBe(14)
    expect(pickUpdateAsset(assets, 'linux', 'x64')).toBeNull()
    expect(
      pickUpdateAsset(
        [
          {
            id: 16,
            name: 'Untrusted-ExcalidrawVisualizer-Windows-x64-Setup.exe',
            size: 100
          }
        ],
        'win32',
        'x64'
      )
    ).toBeNull()
  })

  it('reports the current version as up to date', () => {
    expect(
      describeUpdate(
        '0.5.0',
        {
          id: 10,
          version: '0.5.0',
          pageUrl: 'https://example.invalid',
          assets
        },
        'darwin',
        'arm64'
      )
    ).toEqual({ available: false, latestVersion: '0.5.0' })
  })

  it('requires an immutable checksum asset for an update', () => {
    const update = describeUpdate(
      '0.4.0',
      {
        id: 10,
        version: '0.5.0',
        pageUrl: 'https://example.invalid',
        assets
      },
      'win32',
      'x64'
    )
    expect(update).toMatchObject({
      available: true,
      installable: true,
      latestVersion: '0.5.0',
      asset: {
        id: 14,
        checksumAssetId: 15
      }
    })

    expect(
      describeUpdate(
        '0.4.0',
        {
          id: 10,
          version: '0.5.0',
          pageUrl: 'https://example.invalid',
          assets: assets.filter((asset) => asset.name !== 'SHA256SUMS.txt')
        },
        'win32',
        'x64'
      )
    ).toMatchObject({ available: true, installable: false })
  })

  it('accepts only immutable asset URLs for this repository', () => {
    expect(assetApiUrl(123)).toBe(
      'https://api.github.com/repos/magnuslandahl/ExcalidrawVisualizer/releases/assets/123'
    )
    expect(isTrustedAssetApiUrl(assetApiUrl(123))).toBe(true)
    expect(
      isTrustedAssetApiUrl(
        'https://api.github.com/repos/other/project/releases/assets/123'
      )
    ).toBe(false)
  })
})
