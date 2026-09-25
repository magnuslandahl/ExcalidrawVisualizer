import type { DesktopApi } from '../../shared/contracts'

declare global {
  interface Window {
    desktop: DesktopApi
    EXCALIDRAW_ASSET_PATH: string
    EXCALIDRAW_EXPORT_SOURCE: string
  }
}

export {}
