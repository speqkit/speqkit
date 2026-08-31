import { definePlugin } from '@speqkit/plugin-api'
import { loadTests } from './load.js'
import { registerMigrate } from './migrate.js'

/**
 * The authoring format is a plugin point, not a kernel concept. YAML ships as
 * the default because it is readable by people who do not program; a
 * TypeScript loader is an ordinary plugin someone can publish tomorrow without
 * touching the kernel.
 *
 * Owning the format is also what makes `speq migrate` this plugin's job. A
 * codemod is a reader and a writer of one syntax, and the plugin that decides
 * what `${...}` means is the only honest place to put the thing that rewrites
 * `{{...}}` into it.
 */
export default definePlugin({
  name: '@speqkit/plugin-yaml',
  setup(ctx) {
    ctx.defineLoader('yaml', {
      extensions: ['.yaml', '.yml'],
      load: (file, content) => loadTests(file, content, { root: ctx.host.root })
    })

    registerMigrate(ctx)
  }
})
