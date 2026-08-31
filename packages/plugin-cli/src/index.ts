import { definePlugin, type CommandDef, type CommandHost, type Diagnostic, type RunEvent } from '@speqkit/plugin-api'

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
    ctx.defineReporter('console', { on: printEvent })

    cli.register('run', {
      summary: 'run the tests',
      usage: 'speq run [--env <name>] [--test <file>] [--suite <dir>] [--tags a,b] [--reporter a,b]',
      async run(argv) {
        const tests = await ctx.host.discover({
          test: flag(argv, '--test'),
          suite: flag(argv, '--suite'),
          tags: list(flag(argv, '--tags'))
        })
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
          reporters: list(flag(argv, '--reporter')) ?? DEFAULT_REPORTERS
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

    cli.register('validate', {
      summary: 'check every test against the grammar the loaded plugins define',
      async run() {
        const tests = await ctx.host.discover()
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
      async run() {
        const tests = await ctx.host.discover()
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

/**
 * A reporter is nothing but a function of the event stream. The same stream
 * drives a TUI, the VS Code panel, JUnit output or an external collector —
 * none of which the kernel needs to know exists.
 */
function printEvent(event: RunEvent): void {
  switch (event.type) {
    case 'test.started': {
      // The title when there is one, because `menu.items-create.creates-item`
      // is an identity and not a sentence; the identity stays visible next to
      // it, since that is what a later report is compared against.
      const headline = event.title ?? event.test
      const aside = [event.title ? event.test : '', event.source ?? ''].filter(Boolean).join('  ')
      process.stdout.write(`\n${headline}${aside ? dim(`  ${aside}`) : ''}\n`)
      break
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
      process.stdout.write(`  ${indent}${mark} ${label} ${dim(`${event.durationMs}ms`)}\n`)
      if (event.message) process.stdout.write(`  ${indent}  ${red(event.message)}\n`)
      break
    }
    case 'test.skipped':
      // Printed rather than counted quietly. The reason is the only thing that
      // makes a parked test worth keeping, so it is on screen every run.
      process.stdout.write(`  ${yellow('pending')} ${dim(event.reason)}\n`)
      break
    case 'artifact.attached':
      process.stdout.write(
        `    ${dim('+')} ${event.name} ${dim(`${event.bytes}b${event.path ? ` -> ${event.path}` : ''}`)}\n`
      )
      break
    case 'assertion.evaluated': {
      const mark = event.passed ? green('✓') : red('✗')
      process.stdout.write(`    ${mark} ${dim(event.assertionType)} ${event.message}\n`)
      break
    }
    case 'diagnostic':
      process.stderr.write(`${yellow(event.level)}: ${event.message}\n`)
      break
    case 'run.finished': {
      const parts = [
        green(`${event.passed} passed`),
        event.failed ? red(`${event.failed} failed`) : '',
        event.errored ? yellow(`${event.errored} errored`) : '',
        event.skipped ? dim(`${event.skipped} pending`) : ''
      ].filter(Boolean)
      process.stdout.write(`\n${parts.join(dim(' - '))} ${dim(`in ${event.durationMs}ms`)}\n`)
      break
    }
  }
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) {
    process.stderr.write(`${d.file}  ${d.path}\n  ${d.message}${d.hint ?? ''}\n`)
  }
  process.stderr.write(`\n${diagnostics.length} problem(s)\n`)
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
