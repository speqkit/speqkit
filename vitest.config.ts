import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@speqkit/plugin-api', replacement: r('./packages/plugin-api/src/index.ts') },
      { find: '@speqkit/installer', replacement: r('./packages/installer/src/index.ts') },
      { find: '@speqkit/plugin-gate', replacement: r('./packages/plugin-gate/src/index.ts') },
      { find: '@speqkit/plugin-json', replacement: r('./packages/plugin-json/src/index.ts') },
      { find: '@speqkit/plugin-junit', replacement: r('./packages/plugin-junit/src/index.ts') },
      { find: '@speqkit/test-kit', replacement: r('./packages/test-kit/src/index.ts') },
      { find: '@speqkit/plugin-loop', replacement: r('./packages/plugin-loop/src/index.ts') },
      { find: '@speqkit/plugin-playwright', replacement: r('./packages/plugin-playwright/src/index.ts') },
      { find: '@speqkit/plugin-cli', replacement: r('./packages/plugin-cli/src/index.ts') },
      { find: '@speqkit/plugin-http', replacement: r('./packages/plugin-http/src/index.ts') },
      { find: '@speqkit/plugin-assert', replacement: r('./packages/plugin-assert/src/index.ts') },
      { find: '@speqkit/plugin-data', replacement: r('./packages/plugin-data/src/index.ts') },
      { find: '@speqkit/plugin-use', replacement: r('./packages/plugin-use/src/index.ts') },
      { find: '@speqkit/plugin-yaml', replacement: r('./packages/plugin-yaml/src/index.ts') },
      { find: 'create-speqkit-plugin', replacement: r('./packages/create-speqkit-plugin/src/index.ts') },
      // Anchored: a bare string alias matches by prefix, and the kernel's name
      // is now a prefix of every `speqkit-plugin-*` a community author writes.
      { find: /^speqkit$/, replacement: r('./packages/core/src/index.ts') }
    ]
  },
  test: { include: ['packages/*/test/**/*.test.ts'] }
})
