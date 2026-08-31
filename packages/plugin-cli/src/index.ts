import {
  definePlugin,
  type CommandDef, type CommandHost, type Diagnostic, type DiscoverQuery, type ReporterDef,
  type RunEvent
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
    ctx.defineReporter('console', consoleReporter())

    cli.register('run', {
      summary: 'run the tests',
      usage: 'speq run [--env <name>] [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b] [--reporter a,b] [--workers N]',
      async run(argv) {
        const workers = readWorkers(argv)
        if (typeof workers === 'string') {
          process.stderr.write(`${workers}\n`)
          return EXIT_CONFIG
        }

        const tests = await ctx.host.discover(query(argv))
        if (tests.length === 0) {
          process.stderr.write('no tests matched\n')
          return EXIT_CONFIG
        }

        const diagnostics = ctx.host.validate(tests)
        if (diagnostics.length > 0) {
          printDiagnostics(diagnostics)
          return EXIT_CONFIG
        }

        if (ctx.host.env) process.stdout.write(dim(`environment: ${ctx.host.env}\n`))

        const outcome = await ctx.host.run(tests, {
          reporters: list(flag(argv, '--reporter')) ?? DEFAULT_REPORTERS,
          concurrency: workers
        })
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
      usage: 'speq validate [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b]',
      async run(argv) {
        const tests = await ctx.host.discover(query(argv))
        const diagnostics = ctx.host.validate(tests)

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
      usage: 'speq list [--test <file>] [--suite <dir>] [--tags a,b] [--name a,b]',
      async run(argv) {
        const tests = await ctx.host.discover(query(argv))
        for (const test of tests) {
          const tags = test.tags?.length ? `  [${test.tags.join(', ')}]` : ''
          process.stdout.write(`${test.source ?? '?'}  ${test.name}${tags}\n`)
        }
        process.stdout.write(`\n${tests.length} test(s)\n`)
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
function consoleReporter(): ReporterDef {
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
      const lines = linesFor(event)
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

function testOf(event: RunEvent): string | undefined {
  if ('test' in event) return event.test
  // A diagnostic names what it is about: usually the test, sometimes the suite.
  if (event.type === 'diagnostic') return event.source
  return undefined
}

function linesFor(event: RunEvent): Line[] {
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
