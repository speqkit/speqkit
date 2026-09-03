import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { definePlugin, type ReporterContext } from '@speqkit/plugin-api'
import { SummaryBuilder } from './build.js'

interface JsonConfig {
  /** Where to write, relative to `reports/` unless absolute. */
  output?: string
  /** Write it on one line. Smaller, and no worse for `jq`. */
  compact?: boolean
}

/**
 * The run as one JSON file, for whatever reads a run without being speq.
 *
 * A workflow step that turns a run into a line of prose is not something we
 * can write for anyone: what belongs in a pull request comment differs per
 * team. What we can do is hand over a file whose shape does not move, and
 * then treat that shape as somebody else's contract rather than our
 * convenience. The corpus this was written against reads it with a `jq`
 * expression living in another repository, on a schedule nobody here controls
 * — so the keys it names are fixed, and adding is the only change that is
 * ever safe.
 */
export default definePlugin({
  name: '@speqkit/plugin-json',
  docs: {
    summary: 'writes the run as one JSON document, for a workflow that reads results rather than watches them',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-json#readme',
    examples: [
      {
        title: 'asking for it on a run',
        summary: 'Rebuilt from the event stream, so `speq report` regenerates it without rerunning anything.',
        for: ['json'],
        code: 'speq run --reporter console,json'
      },
      {
        title: 'where it lands, and what a workflow reads out of it',
        for: ['json'],
        code: [
          '# speq.yaml',
          'json:',
          '  output: reports/results/summary.json   # the default',
          '',
          '# in CI',
          "jq '.totals.failed' reports/results/summary.json"
        ].join('\n')
      }
    ]
  },

  configSchema: {
    type: 'object',
    properties: {
      output: { type: 'string' },
      compact: { type: 'boolean' }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const builder = new SummaryBuilder()
    let target: string | undefined

    ctx.defineReporter('json', {
      summary: 'one summary.json: totals, and a row per test with its messages',
      init(run: ReporterContext) {
        builder.reset()
        target = targetFile(ctx.config<JsonConfig>(), run)
      },

      on(event) {
        builder.on(event)
      },

      finalize() {
        if (!target) return
        const config = ctx.config<JsonConfig>()
        mkdirSync(dirname(target), { recursive: true })
        const summary = builder.result()
        writeFileSync(target, `${JSON.stringify(summary, null, config.compact ? undefined : 2)}\n`)
        process.stdout.write(`json: ${target}\n`)
      }
    })
  }
})

/**
 * `reports/results/summary.json` — the stable directory, and the path the
 * suite this was designed for already names.
 *
 * A workflow writes one fixed path into `upload-artifact` and cannot
 * interpolate a run id it will not learn until the step has finished. The
 * per-run directory is right for artifacts, which are addressed from inside
 * the report; it is wrong for the report.
 */
function targetFile(config: JsonConfig, run: ReporterContext): string {
  const output = config.output ?? join('results', 'summary.json')
  if (isAbsolute(output)) return output
  return run.outputDir ? join(run.outputDir, output) : resolve(process.cwd(), output)
}

export { SummaryBuilder } from './build.js'
export type { JsonRun, JsonTest, JsonTotals } from './build.js'
