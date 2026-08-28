import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@speqkit/plugin-api': r('./packages/plugin-api/src/index.ts'),
      '@speqkit/core': r('./packages/core/src/index.ts'),
      '@speqkit/installer': r('./packages/installer/src/index.ts'),
      '@speqkit/plugin-junit': r('./packages/plugin-junit/src/index.ts')
    }
  },
  test: { include: ['packages/*/test/**/*.test.ts'] }
})
