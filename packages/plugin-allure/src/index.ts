import { isAbsolute, join, resolve } from 'node:path'
import { definePlugin, type ReporterContext } from '@speqkit/plugin-api'
import { RunBuilder } from './build.js'
import { writeBundle } from './write.js'

interface AllureConfig {
  /** Where the results directory goes, relative to `reports/` unless absolute. */
  output?: string
  /** Wipe the previous run's results first. On by default — see below. */
  clean?: boolean
  /** Shown as the Environment panel in the report. */
  environment?: Record<string, string>
  /** `executor.json`: what puts the build name and link in the report's header. */
  executor?: Record<string, unknown>
  /** `categories.json`: Allure's own rules for bucketing failures. */
  categories?: unknown[]
  /** Extra `meta` keys to promote into Allure labels, as `{ meta key: label }`. */
  labels?: Record<string, string>
}

/**
 * The report a QA department already has a screen for.
 *
 * Allure is the format v1 users have their history in, their dashboards
 * pointed at and their release sign-off written against, and none of that
 * moves because a framework underneath it did. Without this plugin, migrating
 * costs a team its reports — which is a price nobody pays, so the migration
 * does not happen and the argument about which framework is better never
 * begins.
 *
 * What it writes is a *results* directory, not a report: `allure serve` and
 * `allure generate` turn one into the other, and they are the tools a team
 * already runs. Generating the HTML here would mean shipping a JVM's worth of
 * someone else's renderer inside a plugin, pinned to whatever version we
 * happened to vendor, and it would still not be the one their CI has.
 *
 * Like every reporter in this repository it reads the event stream and
 * nothing else, so `speq report --reporter allure` rebuilds the results of a
 * run that has already finished — including one downloaded out of CI.
 */
export default definePlugin({
  name: '@speqkit/plugin-allure',
  docs: {
    summary: 'writes an Allure results directory, which `allure serve` turns into the report a QA team already reads',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-allure#readme',
    examples: [
      {
        title: 'the two commands, in order',
        summary: 'The run writes results; `allure` renders them. It is the same two steps as every other Allure adapter.',
        for: ['allure'],
        code: [
          'speq run --reporter console,allure',
          'allure serve .speq/reports/allure-results'
        ].join('\n')
      },
      {
        title: 'in CI, where the report is generated rather than served',
        for: ['allure'],
        code: [
          '- run: speq run --env ci --reporter console,allure',
          '- run: allure generate .speq/reports/allure-results -o allure-report --clean',
          '- uses: actions/upload-artifact@v4',
          '  if: always()',
          '  with: { name: allure-report, path: allure-report }'
        ].join('\n')
      },
      {
        title: 'the panel a reader looks at before the failures',
        summary: 'Environment and executor are what tell two red runs apart.',
        for: ['allure'],
        code: [
          '# speq.yaml',
          'allure:',
          '  output: allure-results        # the default, relative to reports/',
          '  environment:',
          '    base url: ${env:BASE_URL}',
          '    branch: ${env:GITHUB_REF_NAME}',
          '  executor:',
          '    name: GitHub Actions',
          '    buildUrl: ${env:GITHUB_SERVER_URL}/${env:GITHUB_REPOSITORY}/actions/runs/${env:GITHUB_RUN_ID}'
        ].join('\n')
      },
      {
        title: 'annotations a test already carries, shown where Allure shows them',
        summary: '`meta` becomes labels and links; a tag stays a tag; a `cases` row becomes the parameters that tell two rows apart.',
        for: ['allure'],
        code: [
          'id: refund lands on the statement',
          'tags: [PAY-114]',
          'meta:',
          '  owner: mira',
          '  severity: critical',
          '  feature: refunds',
          '  issue: https://tracker.example.com/PAY-114'
        ].join('\n')
      }
    ]
  },

  configSchema: {
    type: 'object',
    properties: {
      output: {
        type: 'string',
        description: 'the results directory, relative to the report directory; allure-results by default'
      },
      clean: {
        type: 'boolean',
        description:
          "remove the previous run's results before writing; true by default, because Allure reads the whole directory as one run"
      },
      environment: {
        type: 'object',
        description: "the Environment panel: base url, branch, build — whatever tells two runs apart",
        additionalProperties: { type: 'string', description: 'one row of the panel' }
      },
      executor: {
        type: 'object',
        description: 'executor.json: what puts the build name and a link back to CI in the report header',
        properties: {
          name: { type: 'string', description: 'the CI system, e.g. GitHub Actions' },
          type: { type: 'string', description: "Allure's own key for the icon: github, jenkins, gitlab, teamcity" },
          buildName: { type: 'string', description: 'what this build is called' },
          buildUrl: { type: 'string', description: 'a link back to the build that produced this' },
          reportUrl: { type: 'string', description: 'where the generated report will be published' }
        },
        additionalProperties: true
      },
      categories: {
        type: 'array',
        description: 'categories.json: rules that bucket failures by their message, so a known flake is not read as a new break',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'the bucket, as it appears in the report' },
            matchedStatuses: {
              type: 'array',
              description: 'which statuses fall into it: failed, broken, passed, skipped, unknown',
              items: { type: 'string', description: 'one status' }
            },
            messageRegex: { type: 'string', description: 'a regex over the failure message' },
            traceRegex: { type: 'string', description: 'a regex over the trace' }
          },
          additionalProperties: true
        }
      },
      labels: {
        type: 'object',
        description:
          'extra meta keys to promote into Allure labels, as { meta key: label }; owner, severity, feature, story, epic, package and layer are promoted already',
        additionalProperties: { type: 'string', description: "the Allure label this meta key becomes" }
      }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const config = (): AllureConfig => ctx.config<AllureConfig>()
    let builder = new RunBuilder()
    let target: string | undefined

    ctx.defineReporter('allure', {
      summary: 'writes an allure-results directory: a result per test, a container per test, and the attachments',

      init(run: ReporterContext) {
        // A fresh builder per run rather than `reset()`, because the label map
        // comes out of config and config is only knowable once the session is
        // up — `setup` runs before `speq.yaml` has been applied to a run.
        builder = new RunBuilder({ labels: config().labels })
        target = targetDir(config(), run)
      },

      on(event) {
        builder.on(event)
      },

      finalize() {
        if (!target) return
        const settings = config()
        const report = writeBundle(builder.result(), {
          dir: target,
          clean: settings.clean ?? true,
          environment: {
            ...(ctx.host.env ? { 'speq.env': ctx.host.env } : {}),
            ...(settings.environment ?? {})
          },
          ...(settings.executor ? { executor: settings.executor } : {}),
          ...(settings.categories ? { categories: settings.categories } : {})
        })

        process.stdout.write(
          `allure: ${report.results} result(s) in ${report.dir}\n` +
            `        allure serve ${report.dir}\n`
        )
        // Named, and not fatal. A missing attachment means the run directory
        // was cleaned between the run and the report, which is a thing CI does
        // on purpose — the report is still the report.
        if (report.missing.length > 0) {
          process.stdout.write(
            `        ${report.missing.length} attachment(s) were not on disk to copy: ${report.missing[0]}\n`
          )
        }
      }
    })
  }
})

/**
 * `reports/allure-results` — the stable directory, not `reports/<runId>/`.
 *
 * A workflow names one fixed path in `upload-artifact` and cannot interpolate
 * a run id it will not learn until the step has already finished. It is the
 * same argument `plugin-junit` makes about its file, and it lands harder here:
 * `allure serve` takes a directory as an argument, and a person typing it
 * wants to type the same one every time.
 */
export function targetDir(config: AllureConfig, run: ReporterContext): string {
  const output = config.output ?? 'allure-results'
  if (isAbsolute(output)) return output
  return run.outputDir ? join(run.outputDir, output) : resolve(process.cwd(), output)
}

export { RunBuilder, statusOf, hash, extensionOf } from './build.js'
export type {
  AllureBundle, AllureAttachment, AllureContainer, AllureLabel, AllureLink,
  AllureParameter, AllureResult, AllureStatus, AllureStatusDetails, AllureStep, PendingCopy
} from './build.js'
export { writeBundle, properties } from './write.js'
export type { WriteOptions, WriteReport } from './write.js'
