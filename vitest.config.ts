import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    server: { deps: { inline: ['@excalidraw/excalidraw', 'open-color'] } },
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true
  }
})
