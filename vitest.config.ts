import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@speq/plugin-api': r('./packages/plugin-api/src/index.ts'),
      '@speq/core': r('./packages/core/src/index.ts')
    }
  },
  test: { include: ['packages/*/test/**/*.test.ts'] }
})
