import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { definePlugin, type ReporterContext } from '@speqkit/plugin-api'
import { RunBuilder, renderJUnit } from './build.js'

interface JUnitConfig {
  /** Where to write, relative to `reports/` unless absolute. */
  output?: string
  /** The `name` attribute on `<testsuites>`. */
  suiteName?: string
}

/**
 * The format CI already knows how to read.
 *
 * It is a plugin, and that is the whole argument: JUnit is one of a dozen
 * report formats a team might need, and none of them belong in the kernel.
 * What the kernel owes a reporter is the event stream, and this plugin is the
 * proof that the stream carries enough — every number in the file below is
 * folded out of events, with no access to the runner's own result object.
 */
export default definePlugin({
  name: '@speqkit/plugin-junit',
  docs: {
    summary: 'writes JUnit XML, which is what CI already knows how to render',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-junit#readme',
    examples: [
      {
        title: 'a run CI can show inline',
        summary: 'Name one fixed path in `upload-artifact`: the file does not move between runs.',
        for: ['junit'],
        code: [
          'speq run --reporter console,junit',
          '# reports/results/junit.xml'
        ].join('\n')
      },
      {
        title: 'pointing it somewhere else',
        for: ['junit'],
        code: [
          '# speq.yaml',
          'junit:',
          '  output: reports/junit.xml',
          '  suiteName: acceptance'
        ].join('\n')
      }
    ]
  },

  configSchema: {
    type: 'object',
    properties: {
      output: { type: 'string' },
      suiteName: { type: 'string' }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const builder = new RunBuilder()
    let target: string | undefined

    ctx.defineReporter('junit', {
      summary: 'one junit.xml, a testcase per test and a testsuite per file',
      init(run: ReporterContext) {
        builder.reset()
        target = targetFile(ctx.config<JUnitConfig>(), run)
      },

      on(event) {
        builder.on(event)
      },

      finalize() {
        if (!target) return
        mkdirSync(dirname(target), { recursive: true })
        const xml = renderJUnit(builder.result(), {
          name: ctx.config<JUnitConfig>().suiteName ?? 'speq'
        })
        writeFileSync(target, xml)
        process.stdout.write(`junit: ${target}\n`)
      }
    })
  }
})

/**
 * Defaults to `reports/junit.xml` — the stable directory, not `reports/<runId>/`.
 *
 * A workflow names one fixed path in `upload-artifact` and cannot interpolate a
 * run id it will not learn until the step has already finished. The per-run
 * directory is right for artifacts, which are addressed from inside the report;
 * it is wrong for the report itself.
 */
function targetFile(config: JUnitConfig, run: ReporterContext): string {
  const output = config.output ?? 'junit.xml'
  if (isAbsolute(output)) return output
  return run.outputDir ? join(run.outputDir, output) : resolve(process.cwd(), output)
}

export { RunBuilder, renderJUnit } from './build.js'
export type { JUnitRun, JUnitSuite, JUnitCase } from './build.js'
