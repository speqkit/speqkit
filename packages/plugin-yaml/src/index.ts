import { basename, extname } from 'node:path'
import { parseAllDocuments } from 'yaml'
import { definePlugin, type TestDef } from '@speq/plugin-api'

/**
 * The authoring format is a plugin point, not a kernel concept. YAML ships as
 * the default because it is readable by people who do not program; a
 * TypeScript loader is an ordinary plugin someone can publish tomorrow without
 * touching the kernel.
 */
export default definePlugin({
  name: '@speq/plugin-yaml',
  setup(ctx) {
    ctx.defineLoader('yaml', {
      extensions: ['.yaml', '.yml'],
      load(file, content) {
        const tests: TestDef[] = []
        for (const doc of parseAllDocuments(content)) {
          if (doc.errors.length > 0) {
            throw new Error(`${file}: ${doc.errors[0]!.message}`)
          }
          const value = doc.toJS() as Partial<TestDef> | null
          if (!value) continue
          tests.push({
            name: value.name ?? basename(file, extname(file)),
            tags: value.tags ?? [],
            steps: value.steps ?? [],
            assert: value.assert ?? []
          })
        }
        return tests
      }
    })
  }
})
