import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const excalidrawOfflineFonts = (): Plugin => ({
  name: 'excalidraw-offline-fonts',
  enforce: 'pre',
  transform(code, id) {
    if (
      !id.includes('@excalidraw/excalidraw') ||
      !code.includes('ASSETS_FALLBACK_URL')
    ) {
      return null
    }

    const fallback =
      /return (\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\),\1/
    const transformed = code
      .replace(fallback, 'return $1')
      .replace('https://esm.sh/', '')

    if (transformed === code || transformed.includes('https://esm.sh/')) {
      throw new Error('Unable to remove Excalidraw remote font fallback')
    }

    return transformed
  }
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [excalidrawOfflineFonts(), react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
