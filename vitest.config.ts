import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@speqkit/plugin-api', replacement: r('./packages/plugin-api/src/index.ts') },
      { find: '@speqkit/installer', replacement: r('./packages/installer/src/index.ts') },
      { find: '@speqkit/plugin-junit', replacement: r('./packages/plugin-junit/src/index.ts') },
      { find: '@speqkit/test-kit', replacement: r('./packages/test-kit/src/index.ts') },
      { find: '@speqkit/plugin-loop', replacement: r('./packages/plugin-loop/src/index.ts') },
      { find: '@speqkit/plugin-yaml', replacement: r('./packages/plugin-yaml/src/index.ts') },
      { find: 'create-speqkit-plugin', replacement: r('./packages/create-speqkit-plugin/src/index.ts') },
      // Anchored: a bare string alias matches by prefix, and the kernel's name
      // is now a prefix of every `speqkit-plugin-*` a community author writes.
      { find: /^speqkit$/, replacement: r('./packages/core/src/index.ts') }
    ]
  },
  test: { include: ['packages/*/test/**/*.test.ts'] }
})
