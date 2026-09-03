import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  definePlugin,
  type CommandHost, type Diagnostic, type ReporterContext, type TestDef
} from '@speqkit/plugin-api'
import { GateReport } from './report.js'

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_CONFIG = 2

/**
 * A ticket key as nearly every tracker writes one: letters, a dash, digits.
 *
 * Anchored, because it is matched against one tag at a time and a tag that
 * merely contains a key is a different label. A team whose keys look like
 * something else replaces it in one line of `speq.yaml`.
 */
const DEFAULT_PATTERN = '^[A-Z][A-Z0-9]*-[0-9]+$'

interface GateConfig {
  pattern?: string
  /** Pins the work, for a project where the branch does not name it. */
  key?: string
  /** Read the key out of the current branch name. On unless turned off. */
  branch?: boolean
  /** What `gate diff` compares against. */
  base?: string
}

/**
 * Which tests answer for the work in hand, and whose fault it is when they are
 * red.
 *
 * Everything here is process, and none of it is protocol: this plugin defines
 * no step type and no assertion, because what a test *does* belongs to
 * `http`, `playwright` or whatever somebody publishes next. What it adds is
 * the layer above a run - the question "is this ticket done" instead of "did
 * the suite pass", and the question "where does this failure go" instead of
 * "which line was red".
 *
 * It reads no specification, in any format. A requirement and a test are
 * joined by a tag somebody wrote, and that is the only join there is: what to
 * cover is a team's decision, and a plugin that read a tracker would be wrong
 * about it monthly.
 */
export default definePlugin({
  name: '@speqkit/plugin-gate',
  docs: {
    summary: 'which tests answer for the work in hand, and whose fault it is when they are red',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-gate#readme',
    examples: [
      {
        title: 'the work is the branch',
        summary:
          'The key comes from --key, then gate.key, then the branch name — ' +
          'which is already named after the work.',
        for: ['gate'],
        code: [
          'git checkout -b feature/PAY-114-partial-refunds',
          'speq gate plan     # what would run, and why',
          'speq gate          # run it, and exit on the verdict'
        ].join('\n')
      },
      {
        title: 'what a red run is routed to',
        summary:
          'reports/<runId>/gate.json puts every failure in one of three places: ' +
          'code, environment, or the test itself.',
        for: ['gate'],
        code: [
          'speq gate --json | jq .blame',
          '# { "code": 1, "test": 0, "environment": 0 }'
        ].join('\n')
      },
      {
        title: 'what this branch did to the acceptance tests',
        summary: 'Not a lock. Somebody who believes an acceptance test is wrong is sometimes right.',
        for: ['gate'],
        code: 'speq gate diff --base origin/main'
      }
    ]
  },

  configSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      key: { type: 'string' },
      branch: { type: 'boolean' },
      base: { type: 'string' }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const report = new GateReport()

    /**
     * What a command tells the reporter, in the one direction that is
     * possible: a reporter is registered long before an argv exists.
     *
     * The key is not something the stream can carry - the run does not know
     * which piece of work it was started for - and `--json` decides whether
     * this reporter may write a line of prose onto a stdout somebody is
     * parsing. Both are between this plugin's own halves.
     */
    const session: { key?: string; quiet: boolean } = { quiet: false }
    let target: string | undefined

    ctx.defineReporter('gate', {
      summary: 'one gate.json: the run grouped by work key, with every red test routed to a fix',
      init(run: ReporterContext) {
        report.reset()
        target = run.runDir ? join(run.runDir, 'gate.json') : undefined
      },

      on(event) {
        report.on(event)
      },

      finalize() {
        if (!target) return
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, `${JSON.stringify(document(), null, 2)}\n`)
        if (!session.quiet) process.stdout.write(`gate: ${target}\n`)
      }
    })

    const document = (): Record<string, unknown> =>
      report.result({ pattern: pattern(ctx.config<GateConfig>()), ...(session.key ? { key: session.key } : {}) })

    ctx.inject(['cli'], ({ cli }) => {
      const commands = cli as CommandHost

      commands.register('gate', {
        summary: 'run the tests that answer for the work in hand',
        usage: 'speq gate [--key <key>] [--reporter a,b] [--workers N] [--json] | plan | diff',
        async run(argv) {
          // Subcommands rather than three verbs in the command list: `plan`
          // and `diff` are questions about the same selection `gate` runs, and
          // a caller reading `speq --help` should meet the idea once.
          if (argv[0] === 'plan') return plan(argv.slice(1))
          if (argv[0] === 'diff') return diff(argv.slice(1))
          return gate(argv)
        }
      })

      /** The selection, and the reason for it, without running anything. */
      async function plan(argv: string[]): Promise<number> {
        const config = ctx.config<GateConfig>()
        const asJson = argv.includes('--json')
        const found = resolveKey(argv, config, ctx.host.root)
        const tests = await ctx.host.discover()
        const claimed = (test: TestDef) => (test.tags ?? []).filter((tag) => pattern(config).test(tag))

        const selected = found ? tests.filter((test) => (test.tags ?? []).includes(found.key)) : []
        const unclaimed = tests.filter((test) => claimed(test).length === 0)
        const elsewhere = tests.length - selected.length - unclaimed.length

        if (asJson) {
          writeJson({
            ...(found ? { key: found.key, from: found.from } : {}),
            tests: tests.length,
            selected: selected.map(identify),
            unclaimed: unclaimed.map(identify),
            elsewhere
          })
        } else {
          process.stdout.write(
            found
              ? `key: ${found.key} (${found.from})\n${selected.length} of ${tests.length} test(s) selected\n`
              : `no key: nothing says which work this run is for\n${tests.length} test(s) discovered\n`
          )
          for (const test of selected) process.stdout.write(`  ${test.name}  ${test.source ?? ''}\n`)
          // What was *not* selected is the half a caller cannot get anywhere
          // else, and the half that explains a gate that ran nothing and
          // passed.
          if (elsewhere > 0) process.stdout.write(`${elsewhere} test(s) carry another key\n`)
          if (unclaimed.length > 0) {
            process.stdout.write(`${unclaimed.length} test(s) no gate would run:\n`)
            for (const test of unclaimed) process.stdout.write(`  ${test.name}  ${test.source ?? ''}\n`)
          }
        }

        // A test nobody tagged is not an error by itself - most projects have
        // some - so it is news by default and a failure only where a team has
        // decided every test answers for something.
        if (argv.includes('--strict') && unclaimed.length > 0) return EXIT_CONFIG
        return EXIT_OK
      }

      /** The gate itself: this work's tests, and the verdict on them. */
      async function gate(argv: string[]): Promise<number> {
        const config = ctx.config<GateConfig>()
        const asJson = argv.includes('--json')
        const found = resolveKey(argv, config, ctx.host.root)

        if (!found) {
          process.stderr.write(
            'nothing says which work this is: pass --key, set gate.key, or name the branch after it\n'
          )
          return EXIT_CONFIG
        }

        session.key = found.key
        session.quiet = asJson

        const tests = await ctx.host.discover({ tags: [found.key] })
        if (tests.length === 0) {
          const message = `no test is tagged ${found.key}`
          if (asJson) writeJson({ status: 'no-tests', key: found.key, message })
          else process.stderr.write(`${message}\n`)
          return EXIT_CONFIG
        }

        const diagnostics = ctx.host.validate(tests)
        if (diagnostics.length > 0) {
          if (asJson) writeJson({ status: 'invalid', key: found.key, diagnostics })
          else printDiagnostics(diagnostics)
          return EXIT_CONFIG
        }

        const workers = Number(flag(argv, '--workers') ?? 1)
        const outcome = await ctx.host.run(tests, {
          // The gate reporter is not optional here: it is what the command is
          // for. What `--reporter` chooses is what runs beside it.
          reporters: ['gate', ...(commaList(flag(argv, '--reporter')) ?? (asJson ? [] : ['console']))],
          ...(Number.isFinite(workers) && workers > 0 ? { concurrency: workers } : {})
        })

        if (asJson) writeJson(document())
        return outcome.status === 'passed' ? EXIT_OK : EXIT_FAILED
      }

      /**
       * Which acceptance tests this branch changed.
       *
       * Not a lock and not a refusal. Somebody who believes a test is wrong is
       * sometimes right, and a gate that forbids the amendment moves the
       * argument into a chat window where no reviewer will find it. Tests here
       * are data, so the amendment is already in the diff - what is missing is
       * that nobody reads a YAML diff as a change to the acceptance criteria.
       * Naming them makes it loud without making it forbidden.
       */
      async function diff(argv: string[]): Promise<number> {
        const config = ctx.config<GateConfig>()
        const asJson = argv.includes('--json')
        const base = flag(argv, '--base') ?? config.base ?? 'origin/main'

        // Where the project sits inside the repository, in git's own terms
        // rather than by comparing two absolute paths. On macOS a temporary
        // directory is reached through a symlink, so `--show-toplevel` and
        // `host.root` disagree about their own prefix and every path built
        // from the pair lands outside the repository.
        const prefix = git(['rev-parse', '--show-prefix'], ctx.host.root)
        if (prefix === undefined) {
          process.stderr.write(`not a git repository (or git is not installed): ${ctx.host.root}\n`)
          return EXIT_CONFIG
        }

        // `A...B` compares against where the branch left the base rather than
        // against the base as it is now, so somebody else's merge does not
        // appear in this branch's diff. The pathspec is relative to the
        // project, because that is the directory git is being run in.
        const raw = git(['diff', '--name-status', `${base}...HEAD`, '--', 'suites'], ctx.host.root)
        if (raw === undefined) {
          process.stderr.write(`cannot compare against '${base}': no such ref in this repository\n`)
          return EXIT_CONFIG
        }

        const changes = raw
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\t'))
          .map(([status, path]) => ({ status: (status ?? '').charAt(0), path: path ?? '' }))
          .filter((change) => change.path !== '')

        const of = (letter: string) => changes.filter((c) => c.status === letter).map((c) => c.path)
        const added = of('A')
        const changed = of('M')
        const removed = of('D')

        // The tests inside a file that still exists, so a reviewer reads names
        // rather than paths. A removed file has none to read.
        // git names a file from the root of the repository; `discover` takes
        // one from the root of the project. The prefix between them is the
        // only conversion, and git supplied it.
        const inProject = (path: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : path)
        const named = async (paths: string[]) => {
          const out: Record<string, string[]> = {}
          for (const path of paths) {
            const inside = await ctx.host.discover({ test: inProject(path) })
            out[inProject(path)] = inside.map((test) => test.name)
          }
          return out
        }

        const summary = {
          base,
          added: await named(added),
          changed: await named(changed),
          removed: removed.map(inProject)
        }

        if (asJson) writeJson(summary)
        else {
          const total = added.length + changed.length + removed.length
          process.stdout.write(
            total === 0
              ? `no test file changed against ${base}\n`
              : `${total} test file(s) changed against ${base}\n`
          )
          for (const [label, files] of [['added', summary.added], ['changed', summary.changed]] as const) {
            for (const [path, names] of Object.entries(files)) {
              process.stdout.write(`  ${label}   ${path}\n`)
              for (const name of names) process.stdout.write(`            ${name}\n`)
            }
          }
          for (const path of summary.removed) process.stdout.write(`  removed ${path}\n`)
        }
        return EXIT_OK
      }
    })
  }
})

/* ------------------------------------------------------------------ */
/* Where the key comes from                                            */
/* ------------------------------------------------------------------ */

interface FoundKey { key: string; from: string }

/**
 * The flag, then the config, then the branch - in that order, because the
 * outer one is always the one somebody typed on purpose.
 *
 * The branch is last and is still the one that answers nearly every time: it
 * is already named after the work, so a developer who has checked out
 * `PAY-114` has said which tests are theirs without being asked twice. Where
 * that is not true - a detached checkout, which is how several CI systems
 * check out a pull request - there is a flag, and the plan says which of the
 * three answered.
 */
function resolveKey(argv: string[], config: GateConfig, root: string): FoundKey | undefined {
  const asked = flag(argv, '--key')
  if (asked) return { key: asked, from: 'given with --key' }
  if (config.key) return { key: config.key, from: 'set in speq.yaml' }
  if (config.branch === false) return undefined

  // `symbolic-ref` rather than `rev-parse --abbrev-ref`: it fails on a
  // detached HEAD instead of answering the word "HEAD", and it works in a
  // repository with no commits yet, which is every repository somebody is
  // trying this in for the first time.
  const branch = git(['symbolic-ref', '--short', 'HEAD'], root)
  if (!branch) return undefined

  // A branch is rarely only a key: `PAY-114`, `feature/PAY-114`,
  // `pay/PAY-114-partial-refunds` all name the same work. The anchors are what
  // make the pattern right for a tag and wrong for a branch, so they come off
  // here and nowhere else.
  const search = new RegExp(pattern(config).source.replace(/^\^/, '').replace(/\$$/, ''))
  const found = search.exec(branch)?.[0]
  return found ? { key: found, from: `from the branch '${branch}'` } : undefined
}

function pattern(config: GateConfig): RegExp {
  return new RegExp(config.pattern ?? DEFAULT_PATTERN)
}

/**
 * git, called the way the installer calls it: directly, and never required.
 *
 * Everything git answers here is a convenience - which branch this is, what
 * changed since the base - and a machine without it, or a directory that is no
 * repository, gets `undefined` and a command that says so, rather than a
 * stack trace out of a child process.
 */
function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */

const identify = (test: TestDef) => ({
  name: test.name,
  ...(test.source ? { source: test.source } : {}),
  ...(test.tags?.length ? { tags: test.tags } : {})
})

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  if (at < 0) return undefined
  const value = argv[at + 1]
  return value && !value.startsWith('--') ? value : undefined
}

function commaList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(',').map((part) => part.trim()).filter(Boolean)
}

/** One document, on stdout, whatever the news is. */
function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const problem of diagnostics) {
    process.stderr.write(`${problem.file}: ${problem.path}: ${problem.code}: ${problem.message}\n`)
    if (problem.hint) process.stderr.write(`  ${problem.hint}\n`)
  }
}
