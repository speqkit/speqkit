import { join } from 'node:path'
import {
  definePlugin,
  type Capabilities, type CommandDef, type CommandHost, type Diagnostic, type DiscoverQuery,
  type InputSchema, type ReporterDef, type RunEvent, type RunOutcome, type StepRecord,
  type StepStatus, type TestDef, type TestOutcome
} from '@speqkit/plugin-api'

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_CONFIG = 2

const DEFAULT_REPORTERS = ['console']

/**
 * The CLI is a plugin. Remove it and the framework still runs — from the VS
 * Code extension, from a TUI, from someone's own harness. It publishes the
 * `cli` service, which is how any other plugin contributes a command without
 * depending on the terminal existing at all.
 *
 * Note what it does not import. Every command below drives the kernel through
 * `ctx.host`, and the package.json next to this file names no kernel at all —
 * only `@speqkit/plugin-api`, as a peer. It used to import `speqkit`,
 * and that had the installer place a second kernel in the store and had this
 * file call `bootstrap()` inside a process that had already booted one. This
 * plugin is the reference for every plugin anyone else writes; whatever it
 * does, the ecosystem will do.
 */
export default definePlugin({
  name: '@speqkit/plugin-cli',
  docs: {
    summary: 'the command surface: run, report, validate, list, capabilities — and the console reporter',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-cli#readme',
    examples: [
      {
        title: 'the run somebody actually types',
        summary: 'A tag is the only join between a requirement and the tests that answer for it.',
        for: ['console'],
        code: [
          'speq run --tags PAY-114 --verbose',
          'speq run --env staging --workers 4 --reporter console,junit',
          'speq run --shard 1/4          # in CI, four jobs'
        ].join('\n')
      },
      {
        title: 'asking before running',
        summary:
          'Validation is offline: it checks every step type, field and reference ' +
          'against the loaded plugins without opening a socket.',
        for: ['console'],
        code: [
          'speq validate --tags PAY-114',
          'speq list --suite suites/payments',
          'speq capabilities --json      # the whole grammar, with schemas'
        ].join('\n')
      },
      {
        title: 'rendering a run that already happened',
        summary: 'Reporters are functions of the event stream, so a recorded run re-renders into any of them.',
        for: ['console'],
        code: [
          'speq report --list',
          'speq report --run 0f1c --reporter junit'
        ].join('\n')
      }
    ]
  },

  setup(ctx) {
    const commands = new Map<string, CommandDef>()
    const cli: CommandHost = {
      commands,
      register: (name, def) => {
        if (commands.has(name)) throw new Error(`command '${name}' is already registered`)
        commands.set(name, def)
      }
    }
    ctx.provide('cli', cli)

    /**
     * The terminal output is an ordinary reporter, not a private subscription.
     *
     * It used to call `events.subscribe` directly, which meant the default path
     * went around `defineReporter` and left the mechanism untested by anything
     * a user actually runs. Making the common case use the extension point is
     * the only way to know the extension point works.
     */
    /**
     * `--verbose` belongs to `run` and the exchange it prints belongs to the
     * reporter, and the two meet here because a reporter is registered long
     * before an argv exists. The command sets it; the reporter asks. Nothing
     * outside this plugin can see either half, which is the reason it is a
     * closure and not a field on `RunRequest`: what a reporter prints is
     * between a surface and its own output, not something the kernel arbitrates.
     */
    let verbose = false
    ctx.defineReporter('console', {
      summary: 'prints each test as a block when it finishes; --verbose adds what a failed step was doing',
      ...consoleReporter(() => verbose)
    })

    cli.register('run', {
      summary: 'run the tests',
      usage: 'speq run [--env <name>] [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b] [--reporter a,b] [--workers N] [--shard i/n] [--verbose] [--json]',
      async run(argv) {
        // A malformed flag stays plain text on stderr even here: there is no
        // run to describe, and a caller that wrote `--shard 5/4` has a bug in
        // itself rather than a result to read.
        const asJson = wantsJson(argv)
        verbose = argv.includes('--verbose')
        const workers = readWorkers(argv)
        if (typeof workers === 'string') {
          process.stderr.write(`${workers}\n`)
          return EXIT_CONFIG
        }

        const shard = readShard(argv)
        if (typeof shard === 'string') {
          process.stderr.write(`${shard}\n`)
          return EXIT_CONFIG
        }

        const tests = shardOf(await ctx.host.discover(query(argv)), shard)
        if (tests.length === 0) {
          const message = shard ? 'no tests in this shard' : 'no tests matched'
          if (asJson) writeJson({ status: 'no-tests', message })
          else process.stderr.write(`${message}\n`)
          return EXIT_CONFIG
        }

        const diagnostics = ctx.host.validate(tests)
        if (diagnostics.length > 0) {
          if (asJson) writeJson({ status: 'invalid', diagnostics })
          else printDiagnostics(diagnostics)
          return EXIT_CONFIG
        }

        if (ctx.host.env && !asJson) process.stdout.write(dim(`environment: ${ctx.host.env}\n`))

        const outcome = await ctx.host.run(tests, {
          // `--json` replaces the *default* reporter and not a chosen one:
          // `--json --reporter junit` still writes the XML, because the
          // document on stdout and the file on disk answer different callers.
          reporters: list(flag(argv, '--reporter')) ?? (asJson ? [] : DEFAULT_REPORTERS),
          concurrency: workers
        })
        if (asJson) writeJson(summarise(outcome, ctx.host.reportDir))
        return outcome.status === 'passed' ? EXIT_OK : EXIT_FAILED
      }
    })

    cli.register('report', {
      summary: 'render a run that already happened, without running it again',
      usage: 'speq report [--run <id>] [--reporter a,b] [--list]',
      async run(argv) {
        const runs = ctx.host.runs()

        if (runs.length === 0) {
          process.stderr.write(`no recorded runs in ${ctx.host.reportDir}; run 'speq run' first\n`)
          return EXIT_CONFIG
        }
        if (argv.includes('--list')) {
          for (const run of runs) {
            const when = run.at ? new Date(run.at).toISOString() : 'unknown time'
            process.stdout.write(`${run.runId}  ${when}\n`)
          }
          return EXIT_OK
        }

        const wanted = flag(argv, '--run')
        const chosen = wanted ? runs.find((r) => r.runId.startsWith(wanted)) : runs[0]
        if (!chosen) {
          process.stderr.write(
            `no recorded run matching '${wanted}'. 'speq report --list' shows what is there.\n`
          )
          return EXIT_CONFIG
        }

        const events = await ctx.host.replay(
          chosen,
          list(flag(argv, '--reporter')) ?? DEFAULT_REPORTERS
        )
        const finished = events.find((e) => e.type === 'run.finished')
        return finished?.type === 'run.finished' && finished.status !== 'passed' ? EXIT_FAILED : EXIT_OK
      }
    })

    /**
     * The selection flags are the same three `run` takes, and that is the
     * point rather than a convenience.
     *
     * These two commands used to call `discover()` with no query at all and
     * ignore `--test`, `--suite` and `--tags` in silence — so `speq validate
     * --test suites/one.yaml` checked the whole project and said nothing about
     * it. A checking command that answers a question other than the one it was
     * asked is worse than one that refuses: the answer looks right.
     */
    cli.register('validate', {
      summary: 'check every test against the grammar the loaded plugins define',
      usage: 'speq validate [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b] [--json]',
      async run(argv) {
        const tests = await ctx.host.discover(query(argv))
        const diagnostics = ctx.host.validate(tests)

        // Emitted as they came back, not reshaped. A `Diagnostic` is already
        // the contract's own record — file, path, code, message, hint — and a
        // second spelling of it here would be a second thing to keep in step.
        if (wantsJson(argv)) {
          writeJson({ checked: tests.length, diagnostics })
          return diagnostics.length === 0 ? EXIT_OK : EXIT_CONFIG
        }

        if (diagnostics.length === 0) {
          process.stdout.write(`${tests.length} test(s) valid\n`)
          return EXIT_OK
        }
        printDiagnostics(diagnostics)
        return EXIT_CONFIG
      }
    })

    cli.register('list', {
      summary: 'show the tests that are visible and how to address them',
      usage: 'speq list [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b] [--shard i/n] [--json]',
      async run(argv) {
        // `--shard` is here and not only on `run` because the property worth
        // checking — four shards between them run each test exactly once — is
        // checkable without running anything, and this is where you check it.
        const shard = readShard(argv)
        if (typeof shard === 'string') {
          process.stderr.write(`${shard}\n`)
          return EXIT_CONFIG
        }

        const tests = shardOf(await ctx.host.discover(query(argv)), shard)

        if (wantsJson(argv)) {
          writeJson({ tests: tests.map(identityOf) })
          return EXIT_OK
        }

        for (const test of tests) {
          const tags = test.tags?.length ? `  [${test.tags.join(', ')}]` : ''
          process.stdout.write(`${test.source ?? '?'}  ${test.name}${tags}\n`)
        }
        process.stdout.write(`\n${tests.length} test(s)\n`)
        return EXIT_OK
      }
    })

    /**
     * The grammar, from the session that actually knows it.
     *
     * `speq plugins` answers "who is loaded and what did they bring", grouped
     * by owner. This answers "what may I write", grouped by kind and carrying
     * the schemas — which is the half a machine needs and the half that has
     * never left the process. It is a plugin command rather than a bootstrap
     * one for the same reason `run` is: the question is about the plugins,
     * so it cannot be asked before they are loaded.
     */
    cli.register('capabilities', {
      summary: 'the grammar the loaded plugins define, with the schemas',
      usage: 'speq capabilities [--json]',
      run(argv) {
        const capabilities = ctx.host.capabilities()
        if (wantsJson(argv)) writeJson(capabilities)
        else printCapabilities(capabilities)
        return EXIT_OK
      }
    })
  }
})

const E = '\x1b['
const dim = (s: string) => `${E}2m${s}${E}0m`
const green = (s: string) => `${E}32m${s}${E}0m`
const red = (s: string) => `${E}31m${s}${E}0m`
const yellow = (s: string) => `${E}33m${s}${E}0m`

interface Line {
  text: string
  /** Diagnostics go to stderr, and keep doing so from inside a buffer. */
  err?: true
}

/**
 * A reporter is nothing but a function of the event stream. The same stream
 * drives a TUI, the VS Code panel, JUnit output or an external collector —
 * none of which the kernel needs to know exists.
 *
 * This one holds a test's lines until the test is over, and prints the block
 * whole. It used to write each event through as it arrived, which reads
 * perfectly while one test runs at a time and turns to noise the moment two
 * do: two tests' steps arriving alternately, indented under whichever header
 * was printed last. G4 permits exactly that.
 *
 * Held per **test**, not per suite. A suite at eight workers is minutes of
 * silence, and — the real reason — a suite's tests are not contiguous in the
 * output any more, so a suite header printed once would head one block and be
 * missing from the next. Each test's own header carries its source, which is
 * the grouping a reader actually needs. Adjacency is what this milestone takes
 * away; a reporter must not put it back.
 */
function consoleReporter(verbose: () => boolean): ReporterDef {
  /** Lines held for a test that has not finished yet, by test name. */
  let held = new Map<string, Line[]>()

  const flush = (test: string): void => {
    const lines = held.get(test)
    if (!lines) return
    held.delete(test)
    for (const line of lines) (line.err ? process.stderr : process.stdout).write(line.text)
  }

  return {
    init() {
      held = new Map()
    },

    on(event) {
      const lines = linesFor(event, verbose())
      const owner = testOf(event)
      const buffer = owner === undefined ? undefined : held.get(owner)

      if (event.type === 'test.started') {
        held.set(event.test, lines)
        return
      }

      // A stream that never announced the test — a panel replaying a
      // fragment, a plugin driving the reporter directly — is printed as it
      // arrives rather than swallowed.
      if (buffer) buffer.push(...lines)
      else for (const line of lines) (line.err ? process.stderr : process.stdout).write(line.text)

      if (event.type === 'test.finished') flush(event.test)
      // Whatever is still open when the run ends never got its `test.finished`.
      // Losing it silently would be the worst of both designs.
      if (event.type === 'run.finished') for (const test of [...held.keys()]) flush(test)
    }
  }
}

/**
 * A recorded detail, as lines a terminal can hold.
 *
 * JSON rather than anything cleverer: the shape belongs to whichever step type
 * wrote it, and a printer that assumed a request and a response would print
 * nothing useful for the database step somebody publishes next month.
 */
function describe(detail: unknown): string[] {
  try {
    return JSON.stringify(detail, null, 2).split('\n')
  } catch {
    return [String(detail)]
  }
}

function testOf(event: RunEvent): string | undefined {
  if ('test' in event) return event.test
  // A diagnostic names what it is about: usually the test, sometimes the suite.
  if (event.type === 'diagnostic') return event.source
  return undefined
}

function linesFor(event: RunEvent, verbose = false): Line[] {
  switch (event.type) {
    case 'test.started': {
      // The title when there is one, because `menu.items-create.creates-item`
      // is an identity and not a sentence; the identity stays visible next to
      // it, since that is what a later report is compared against.
      const headline = event.title ?? event.test
      const aside = [event.title ? event.test : '', event.source ?? ''].filter(Boolean).join('  ')
      return [{ text: `\n${headline}${aside ? dim(`  ${aside}`) : ''}\n` }]
    }
    case 'step.finished': {
      const indent = '  '.repeat(Math.max(0, event.depth - 1))
      const mark = event.status === 'passed' ? green('.') : red('x')
      const named = typeof event.meta?.name === 'string' ? event.meta.name : undefined
      const label = named
        ? `${named} ${dim(`(${event.stepType})`)}`
        : event.stepId
          ? `${event.stepId} ${dim(`(${event.stepType})`)}`
          : event.stepType
      // A step with no test is a suite's own setup or cleanup. It has no
      // header above it — there is no test to head — so it says where it is.
      const where = event.test === undefined && event.suite ? dim(`  ${event.suite}`) : ''
      const lines: Line[] = [
        { text: `  ${indent}${mark} ${label} ${dim(`${event.durationMs}ms`)}${where}\n` }
      ]
      if (event.message) lines.push({ text: `  ${indent}  ${red(event.message)}\n` })
      // What the step recorded about itself — the request and the response,
      // for an HTTP step. It rides only on a step that did not pass, so this
      // prints nothing on a green run however loud the flag is.
      if (verbose && event.detail !== undefined) {
        for (const line of describe(event.detail)) {
          lines.push({ text: `  ${indent}  ${dim(line)}\n` })
        }
      }
      return lines
    }
    case 'test.skipped':
      // Printed rather than counted quietly. The reason is the only thing that
      // makes a parked test worth keeping, so it is on screen every run.
      return [{ text: `  ${yellow('pending')} ${dim(event.reason)}\n` }]
    case 'artifact.attached':
      return [{
        text: `    ${dim('+')} ${event.name} ${dim(`${event.bytes}b${event.path ? ` -> ${event.path}` : ''}`)}\n`
      }]
    case 'assertion.evaluated': {
      const mark = event.passed ? green('✓') : red('✗')
      return [
        { text: `    ${mark} ${dim(event.assertionType)} ${event.message}\n` },
        ...comparison(event).map((line) => ({ text: `      ${line}\n` }))
      ]
    }
    case 'diagnostic':
      return [{ text: `${yellow(event.level)}: ${event.message}\n`, err: true }]
    case 'run.finished': {
      const parts = [
        green(`${event.passed} passed`),
        event.failed ? red(`${event.failed} failed`) : '',
        event.errored ? yellow(`${event.errored} errored`) : '',
        event.skipped ? dim(`${event.skipped} pending`) : ''
      ].filter(Boolean)
      return [{ text: `\n${parts.join(dim(' - '))} ${dim(`in ${event.durationMs}ms`)}\n` }]
    }
    default:
      return []
  }
}

/* ------------------------------------------------------------------ */
/* The diff                                                            */
/* ------------------------------------------------------------------ */

const DIFF_LINE_BUDGET = 40

/**
 * What a failed assertion compared, when the values are in the event.
 *
 * The alternative was a proxy: the message says "expected 201, got 500" and
 * stops, so anything shaped — a body, a header set, a list — had to be read by
 * running the suite again with something in front of it. Nothing here is
 * computed; the values arrive on `assertion.evaluated` and this only decides
 * how they are laid out.
 */
function comparison(event: Extract<RunEvent, { type: 'assertion.evaluated' }>): string[] {
  if (event.expected === undefined && event.actual === undefined) return []

  const expected = render(event.expected)
  const actual = render(event.actual)

  // Two scalars are a comparison, not a diff. `- 201 / + 500` is diff notation
  // applied to something that has no structure to align.
  if (expected.length === 1 && actual.length === 1) {
    return [`${dim('expected')} ${green(expected[0]!)}`, `${dim('actual  ')} ${red(actual[0]!)}`]
  }
  return [`${green('- expected')}  ${red('+ actual')}`, ...clip(unified(expected, actual))]
}

function render(value: unknown): string[] {
  if (value === undefined) return [dim('(nothing)')]
  try {
    return JSON.stringify(value, null, 2)?.split('\n') ?? [String(value)]
  } catch {
    // A value that cannot be serialised is still worth naming.
    return [String(value)]
  }
}

/** Longest common subsequence over lines: the ordinary unified diff. */
function unified(left: string[], right: string[]): string[] {
  const common = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      common[i]![j] = left[i] === right[j]
        ? common[i + 1]![j + 1]! + 1
        : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
    }
  }

  const out: string[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push(dim(`  ${left[i]}`))
      i++
      j++
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      out.push(green(`- ${left[i]}`))
      i++
    } else {
      out.push(red(`+ ${right[j]}`))
      j++
    }
  }
  while (i < left.length) out.push(green(`- ${left[i++]}`))
  while (j < right.length) out.push(red(`+ ${right[j++]}`))
  return out
}

/** A 900-line body is not a diff anybody reads in a terminal. */
function clip(lines: string[]): string[] {
  if (lines.length <= DIFF_LINE_BUDGET) return lines
  const rest = lines.length - DIFF_LINE_BUDGET
  return [...lines.slice(0, DIFF_LINE_BUDGET), dim(`… ${rest} more line(s); the full values are in the report`)]
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) {
    process.stderr.write(`${d.file}  ${d.path}\n  ${d.message}${d.hint ?? ''}\n`)
  }
  process.stderr.write(`\n${diagnostics.length} problem(s)\n`)
}

/* ------------------------------------------------------------------ */
/* The machine-readable side                                           */
/* ------------------------------------------------------------------ */

/**
 * `--json`: this command's answer as one document on stdout.
 *
 * The bet the whole project rests on is that a generated suite can be checked
 * before it runs. Checking it meant reading `speq validate` — a sentence per
 * problem, coloured, on stderr — so the caller doing the checking had to match
 * substrings, and a reworded message silently changed what it concluded. With
 * `--json` the answer has a shape, and `Diagnostic.code` has a spelling that
 * does not move.
 *
 * On stdout even when the news is bad, and even from `run`. stderr keeps what
 * it always had: things that went wrong with the command rather than with the
 * tests.
 */
function wantsJson(argv: string[]): boolean {
  return argv.includes('--json')
}

/** Indented, because a person reads this too — a machine cannot tell. */
function writeJson(document: unknown): void {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
}

/**
 * What `list --json` says about a test: its identity, and where it lives.
 *
 * Deliberately not the `TestDef`. The steps are in the file the `source` names
 * and a caller that wants them can read it; what only speq can answer is which
 * tests exist after loaders ran, `cases` tables expanded and the four
 * selection flags were applied — the names a `--name` would take.
 */
function identityOf(test: TestDef): Record<string, unknown> {
  return {
    name: test.name,
    title: test.title,
    source: test.source,
    /** Outermost first, the chain of declared suites the test is inside. */
    suites: test.suites?.map((suite) => suite.name) ?? [],
    /** The name the `cases` table was written under, when it came from one. */
    group: test.group,
    tags: test.tags ?? [],
    pending: test.pending
  }
}

/** One thing that went wrong, flat enough to switch on. */
interface Failure {
  kind: 'step' | 'assertion'
  /** The step it happened in, when the step had an id to name it by. */
  step?: string
  /** The step type, or the assertion type. */
  type: string
  status?: StepStatus
  message?: string
  expected?: unknown
  actual?: unknown
  /** What the step recorded about itself — see `ExecContext.record`. */
  detail?: unknown
}

/**
 * What `run --json` prints once the run is over.
 *
 * The counts and the status are the whole outcome; per test it carries the
 * identity and the failures and stops there. The alternative was the whole
 * `TestOutcome` — every step, every result, every artifact — but that is the
 * report, and the report is already on disk under `runDir`, in a form nothing
 * here has to keep in step. This document is what a caller reads to decide
 * what to do next.
 */
function summarise(outcome: RunOutcome, reportDir: string): Record<string, unknown> {
  return {
    status: outcome.status,
    runId: outcome.runId,
    durationMs: outcome.durationMs,
    passed: outcome.passed,
    failed: outcome.failed,
    errored: outcome.errored,
    skipped: outcome.skipped,
    /** Where the event log and the artifacts of this run were written. */
    runDir: join(reportDir, outcome.runId),
    tests: outcome.tests.map((test) => ({
      name: test.name,
      status: test.status,
      durationMs: test.durationMs,
      suite: test.suite,
      source: test.source,
      pending: test.pending,
      // Present and empty on a green test, so the shape of a row does not
      // depend on how the row came out.
      failures: failuresOf(test)
    }))
  }
}

function failuresOf(test: TestOutcome): Failure[] {
  const failures: Failure[] = []

  const assertions = (of: (AssertOutcomeRecord)[] | undefined, step?: string): void => {
    for (const outcome of of ?? []) {
      if (outcome.passed) continue
      failures.push({
        kind: 'assertion',
        step,
        type: outcome.type,
        message: outcome.message,
        expected: outcome.expected,
        actual: outcome.actual
      })
    }
  }

  // Nested records included, because a step that failed inside a loop is the
  // step that failed; the loop around it only reports that something did.
  const walk = (records: StepRecord[]): void => {
    for (const record of records) {
      if (record.status === 'failed' || record.status === 'error') {
        failures.push({
          kind: 'step',
          step: record.id,
          type: record.type,
          status: record.status,
          message: record.message,
          // The half a repair loop could not get anywhere else: a caller
          // reading this document has the exchange without opening the log,
          // and without running the test a second time to watch it happen.
          detail: record.detail
        })
      }
      assertions(record.assertions, record.id)
      if (record.children) walk(record.children)
    }
  }

  walk(test.steps)
  assertions(test.assertions)
  return failures
}

type AssertOutcomeRecord = TestOutcome['assertions'][number]

/**
 * The grammar as a person reads it: what may be written, and by whose leave.
 *
 * A star marks a field the schema requires. The rest of the schema — types,
 * enums, nested shapes — is in `--json`, because a terminal is where you find
 * out that `http` exists and takes a `url`, not where you settle whether
 * `timeout` is a number or a string.
 */
function printCapabilities(capabilities: Capabilities): void {
  const plugins = capabilities.plugins
    .map((plugin) => (plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name))
    .join(', ')
  process.stdout.write(`plugin-api v${capabilities.apiVersion}\n${dim(plugins)}\n`)

  const section = (
    title: string,
    entries: { name: string; plugin: string; note?: string; schema?: InputSchema }[]
  ): void => {
    process.stdout.write(`\n${title}\n`)
    if (entries.length === 0) {
      process.stdout.write(`${dim('  (none)')}\n`)
      return
    }
    const width = Math.max(...entries.map((entry) => entry.name.length))
    for (const entry of entries) {
      const note = entry.note ? `  ${dim(entry.note)}` : ''
      process.stdout.write(`  ${entry.name.padEnd(width)}  ${dim(entry.plugin)}${note}\n`)
      const fields = fieldsOf(entry.schema)
      if (fields) process.stdout.write(`  ${' '.repeat(width)}  ${fields}\n`)
    }
  }

  section('step types', capabilities.stepTypes)
  section('assertions', capabilities.assertions)
  section(
    'value providers',
    // Shown as the thing that is written, not as the name it was registered
    // under: nobody types the registration name into a suite.
    capabilities.valueProviders.map((provider) => ({ ...provider, name: `\${${provider.prefix}:…}` }))
  )
  section('reporters', capabilities.reporters)
  section(
    'loaders',
    capabilities.loaders.map((loader) => ({
      ...loader,
      note: [
        loader.extensions.join(' '),
        loader.suiteFiles?.length ? `suite: ${loader.suiteFiles.join(', ')}` : ''
      ].filter(Boolean).join('   ')
    }))
  )
}

/** `method* url* headers body` — the fields, starred where required. */
function fieldsOf(schema: InputSchema | undefined): string | undefined {
  if (!schema) return undefined
  const required = new Set(schema.required ?? [])
  // Required-but-undeclared is a schema somebody wrote by hand; it is still a
  // field you have to write, so it belongs in the line.
  const names = [...new Set([...Object.keys(schema.properties ?? {}), ...required])]
  if (names.length === 0) return undefined
  return names.map((name) => (required.has(name) ? `${name}*` : dim(name))).join(' ')
}

/**
 * `--workers N`: how many suites may be in flight at once. One when absent.
 *
 * Returns the message rather than printing it, so the command decides what a
 * bad flag costs — here, refusing to run at all. A run that quietly fell back
 * to one worker after being asked for eight would be a twenty-minute suite
 * pretending to obey.
 *
 * There is no `auto`, and the refusal says so. Every framework surveyed
 * defaults to the CPU count because their bottleneck is the local processor;
 * ours is somebody else's service, and N suites at once is N times the load on
 * it. Nothing here can know what that system will take.
 */
function readWorkers(argv: string[]): number | string {
  const raw = flag(argv, '--workers')
  if (raw === undefined) return 1
  const workers = Number(raw)
  if (!Number.isInteger(workers) || workers < 1) {
    return `--workers takes a whole number of 1 or more, and got '${raw}'. ` +
      'There is no auto: N suites at once is N times the load on the system under test, ' +
      'and only you know what it will take.'
  }
  return workers
}

interface Shard {
  /** 1-based, the way it is written on the command line. */
  index: number
  of: number
}

/**
 * `--shard i/n`: this machine takes the i-th of n slices.
 *
 * A shard is not a fifth selection flag. The other four say which tests you
 * care about; this one says you care about all of them and there are n
 * machines. So it is applied to what discovery returned rather than asked of
 * discovery, and it is the last thing applied — sharding a selection is a
 * sensible thing to want, selecting from a shard is not.
 *
 * Refused rather than guessed at, for the same reason as `--workers`: a run
 * that silently took the whole suite after being asked for a quarter of it is
 * a machine doing four times the work it was told to, and nothing says so.
 */
function readShard(argv: string[]): Shard | undefined | string {
  const raw = flag(argv, '--shard')
  if (raw === undefined) return undefined

  const wrong = `--shard takes i/n — the i-th of n slices, both whole numbers, 1 <= i <= n — and got '${raw}'.`
  const parts = raw.split('/')
  if (parts.length !== 2) return wrong

  const index = Number(parts[0])
  const of = Number(parts[1])
  if (!Number.isInteger(index) || !Number.isInteger(of)) return wrong
  if (of < 1 || index < 1 || index > of) return wrong

  return { index, of }
}

/**
 * The i-th of n contiguous slices of the discovered order.
 *
 * Sliced by **test** rather than by file, which is the fork this had to pick.
 * Slicing by file keeps a file whole but leaves a thousand tests in one file
 * as one shard — and with a `cases` table a thousand tests in one file is now
 * a single test, so that is the case shards exist to answer and it would go
 * unanswered. What slicing by test costs is that a file on a boundary is split,
 * and its `suite`-scoped resources are then set up in both shards. That cost
 * is already paid one level up: a shard is a separate process, so every
 * *directory* suite's setup already runs once per shard whatever the unit is.
 * Slicing by test makes the rule one sentence rather than two — a shard is an
 * independent run, and every suite that has work in it opens in it.
 *
 * Contiguous slices rather than round-robin, because they cost the least of
 * that: `i % n` splits every multi-test file across every shard, while a
 * contiguous cut splits at most n-1 files in the whole run. Both balance by
 * count; only one of them also keeps files together by accident.
 *
 * The remainder goes to the low shards one test each, so no two shards differ
 * by more than one test, every test lands in exactly one shard, and the n
 * slices put back together are the discovered order unchanged.
 */
function shardOf(tests: TestDef[], shard: Shard | undefined): TestDef[] {
  if (!shard) return tests
  const size = Math.floor(tests.length / shard.of)
  const extra = tests.length % shard.of
  const before = shard.index - 1
  const start = before * size + Math.min(before, extra)
  return tests.slice(start, start + size + (before < extra ? 1 : 0))
}

/** The four flags that decide which tests a command is talking about. */
function query(argv: string[]): DiscoverQuery {
  return {
    test: flag(argv, '--test'),
    suite: flag(argv, '--suite'),
    tags: list(flag(argv, '--tags')),
    // `--name` is the one that addresses a single test, cases included:
    // `--name 'menu.create[eur]'`. The other three say where to look or what
    // to look for, and after reading a report what you want is that one row.
    names: list(flag(argv, '--name'))
  }
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
