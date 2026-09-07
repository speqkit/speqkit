import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { definePlugin, type Capabilities, type ReporterContext } from '@speqkit/plugin-api'
import { ReportBuilder, type HtmlOwners } from './model.js'
import { embedArtifacts } from './embed.js'
import { renderHtml } from './render.js'

interface HtmlConfig {
  /** Where to write, relative to `reports/` unless absolute. */
  output?: string
  /** The page title, and the heading at the top of it. */
  title?: string
  /** Largest single artifact carried inside the page, in bytes. */
  inlineLimit?: number
  /** How many bytes of artifacts the page may carry in total. */
  inlineBudget?: number
}

/** 512 KB a file, 8 MB in total — a screenshot rides along, a video does not. */
const PER_FILE = 512 * 1024
const BUDGET = 8 * 1024 * 1024

/**
 * One HTML file, opened by double-clicking it.
 *
 * The report Allure makes is a directory of JSON that its page fetches, and a
 * browser opening `file://` refuses those fetches — which is why `allure serve`
 * exists, and why reading a report requires a second tool on the reader's
 * machine and a JVM behind it. That is a real cost paid by real people: the
 * developer who downloads a CI artifact to find out why their branch is red
 * does not want to install anything.
 *
 * So this writes one file with nothing outside it. No fetch, no CDN, no
 * framework, no second command. It mails, it attaches to a pull request, it
 * opens on a laptop with no network — and the failures are already expanded
 * when it does, because a report is read for its failures.
 *
 * It is a reporter like every other one here, so it reads the event stream and
 * nothing else, with one deliberate exception: the plugin that owns each step
 * type comes from `host.capabilities()`. The stream says a step's type and can
 * never say whose type it is, and "which plugin is responsible for this line"
 * is the question a reader of somebody else's suite actually has.
 */
export default definePlugin({
  name: '@speqkit/plugin-html',
  docs: {
    summary: 'writes one self-contained HTML report, with no second tool and no server to read it',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-html#readme',
    examples: [
      {
        title: 'a run somebody can read without installing anything',
        summary: 'One file. Double-click it.',
        for: ['html'],
        code: [
          'speq run --reporter console,html',
          'open .speq/reports/report.html'
        ].join('\n')
      },
      {
        title: 'in CI, as the artifact a red build links to',
        for: ['html'],
        code: [
          '- run: speq run --env ci --reporter console,html',
          '- uses: actions/upload-artifact@v4',
          '  if: always()',
          '  with: { name: speq-report, path: .speq/reports/report.html }'
        ].join('\n')
      },
      {
        title: 'the two numbers worth setting',
        summary: 'Screenshots ride inside the file up to a budget; past it they stay links back into reports/.',
        for: ['html'],
        code: [
          '# speq.yaml',
          'html:',
          '  output: report.html      # the default, relative to reports/',
          '  title: payments nightly',
          '  inlineLimit: 524288      # per artifact',
          '  inlineBudget: 8388608    # in total'
        ].join('\n')
      },
      {
        title: 'rebuilding the page for a run that already happened',
        summary: 'The reporter is a function of the event stream, so a downloaded reports/ re-renders offline.',
        for: ['html'],
        code: 'speq report --run 0f1c --reporter html'
      }
    ]
  },

  configSchema: {
    type: 'object',
    properties: {
      output: {
        type: 'string',
        description: 'where the page is written, relative to the report directory; report.html by default'
      },
      title: {
        type: 'string',
        description: 'the page title and its heading; "speq run" by default'
      },
      inlineLimit: {
        type: 'integer',
        minimum: 0,
        description: 'largest single artifact carried inside the page, in bytes; 524288 by default. Anything larger stays a link into reports/'
      },
      inlineBudget: {
        type: 'integer',
        minimum: 0,
        description: 'how many bytes of artifacts the page may carry in total; 8388608 by default'
      }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const builder = new ReportBuilder()
    let target: string | undefined

    ctx.defineReporter('html', {
      summary: 'one self-contained report.html: totals, filters, the step tree, diffs and screenshots',

      init(run: ReporterContext) {
        builder.reset()
        target = targetFile(ctx.config<HtmlConfig>(), run)
      },

      on(event) {
        builder.on(event)
      },

      finalize() {
        if (!target) return
        const config = ctx.config<HtmlConfig>()
        const report = builder.result({
          owners: ownersOf(ctx.host.capabilities()),
          ...(ctx.host.env ? { env: ctx.host.env } : {})
        })

        const embedded = embedArtifacts(report, {
          target,
          perFile: config.inlineLimit ?? PER_FILE,
          budget: config.inlineBudget ?? BUDGET
        })

        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, renderHtml(report, { title: config.title ?? 'speq run' }))

        process.stdout.write(`html: ${target}\n`)
        // The counts, because "why is this file 9 MB" and "why is that
        // screenshot a broken image" are both answered here and nowhere else.
        if (embedded.linked > 0 || embedded.missing > 0) {
          process.stdout.write(
            `      ${embedded.inlined} artifact(s) inside the page, ` +
              `${embedded.linked} left as link(s) into reports/` +
              (embedded.missing > 0 ? `, ${embedded.missing} not on disk` : '') +
              '\n'
          )
        }
      }
    })
  }
})

/**
 * The grammar, keyed the way a step names itself.
 *
 * This is the one thing on the page that does not come from the stream, and it
 * is deliberately taken from the *running session* rather than from a table
 * baked into this plugin: the answer in a project with one more plugin
 * installed has one more entry in it.
 */
export function ownersOf(capabilities: Capabilities): HtmlOwners {
  const index = (list: Capabilities['stepTypes']): Record<string, { plugin: string; summary?: string }> => {
    const out: Record<string, { plugin: string; summary?: string }> = {}
    for (const entry of list) {
      out[entry.name] = { plugin: entry.plugin, ...(entry.summary ? { summary: entry.summary } : {}) }
    }
    return out
  }
  return { steps: index(capabilities.stepTypes), assertions: index(capabilities.assertions) }
}

/**
 * `reports/report.html` — the stable directory, not `reports/<runId>/`.
 *
 * A workflow names one fixed path in `upload-artifact` and cannot interpolate
 * a run id it will not learn until the step has already finished. The per-run
 * directory is right for artifacts, which this page addresses *from* the
 * report; it is wrong for the report.
 */
export function targetFile(config: HtmlConfig, run: ReporterContext): string {
  const output = config.output ?? 'report.html'
  if (isAbsolute(output)) return output
  return run.outputDir ? join(run.outputDir, output) : resolve(process.cwd(), output)
}

export { ReportBuilder } from './model.js'
export type {
  HtmlArtifact, HtmlAssertion, HtmlOwner, HtmlOwners, HtmlReport, HtmlStep,
  HtmlSuite, HtmlTest, HtmlTotals
} from './model.js'
export { embedArtifacts } from './embed.js'
export type { EmbedOptions, EmbedReport } from './embed.js'
export { renderHtml } from './render.js'
export type { RenderOptions } from './render.js'
