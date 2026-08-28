import { join } from 'node:path'
import { definePlugin, type CommandDef, type CommandHost, type RunEvent } from '@speq/plugin-api'
import { bootstrap, discoverTests, runTests, validateTests } from '@speq/core'
import type { Registry, Diagnostic } from '@speq/core'

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_CONFIG = 2

/**
 * The CLI is a plugin. Remove it and the framework still runs — from the VS
 * Code extension, from a TUI, from someone's own harness. It publishes the
 * `cli` service, which is how any other plugin contributes a command without
 * depending on the terminal existing at all.
 */
export default definePlugin({
  name: '@speq/plugin-cli',

  setup(ctx) {
    const commands = new Map<string, CommandDef>()
    const host: CommandHost = {
      commands,
      register: (name, def) => {
        if (commands.has(name)) throw new Error(`command '${name}' is already registered`)
        commands.set(name, def)
      }
    }
    ctx.provide('cli', host)

    host.register('run', {
      summary: 'run the tests',
      usage: 'speq run [--test <file>] [--suite <dir>] [--tags a,b]',
      async run(argv) {
        const session = await bootstrap(flag(argv, '--speq-root'))
        attachConsoleReporter(session.registry)

        const tests = await discoverTests(session.registry, {
          root: session.root.root,
          test: flag(argv, '--test'),
          suite: flag(argv, '--suite'),
          tags: flag(argv, '--tags')?.split(',').map((t) => t.trim()).filter(Boolean)
        })
        if (tests.length === 0) {
          process.stderr.write('no tests matched\n')
          return EXIT_CONFIG
        }

        const diagnostics = validateTests(session.registry, tests)
        if (diagnostics.length > 0) {
          printDiagnostics(diagnostics)
          return EXIT_CONFIG
        }

        const outcome = await runTests(session.registry, tests, {
          artifactDir: join(session.root.root, 'reports')
        })
        return outcome.status === 'passed' ? EXIT_OK : EXIT_FAILED
      }
    })

    host.register('validate', {
      summary: 'check every test against the grammar the loaded plugins define',
      async run(argv) {
        const session = await bootstrap(flag(argv, '--speq-root'))
        const tests = await discoverTests(session.registry, { root: session.root.root })
        const diagnostics = validateTests(session.registry, tests)

        if (diagnostics.length === 0) {
          process.stdout.write(`${tests.length} test(s) valid\n`)
          return EXIT_OK
        }
        printDiagnostics(diagnostics)
        return EXIT_CONFIG
      }
    })

    host.register('list', {
      summary: 'show the tests that are visible and how to address them',
      async run(argv) {
        const session = await bootstrap(flag(argv, '--speq-root'))
        const tests = await discoverTests(session.registry, { root: session.root.root })
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
 * A reporter is nothing but an event listener. The same stream drives a TUI,
 * the VS Code panel, JUnit output or an external collector — none of which the
 * kernel needs to know exists.
 */
function attachConsoleReporter(registry: Registry): void {
  registry.events.subscribe((event: RunEvent) => {
    switch (event.type) {
      case 'test.started':
        process.stdout.write(`\n${event.test}${event.source ? dim(`  ${event.source}`) : ''}\n`)
        break
      case 'step.finished': {
        const indent = '  '.repeat(Math.max(0, event.depth - 1))
        const mark = event.status === 'passed' ? green('.') : red('x')
        const label = event.stepId ? `${event.stepId} ${dim(`(${event.stepType})`)}` : event.stepType
        process.stdout.write(`  ${indent}${mark} ${label} ${dim(`${event.durationMs}ms`)}\n`)
        if (event.message) process.stdout.write(`  ${indent}  ${red(event.message)}\n`)
        break
      }
      case 'artifact.attached':
        process.stdout.write(`    ${dim('+')} ${event.name} ${dim(`${event.bytes}b${event.path ? ` -> ${event.path}` : ''}`)}\n`)
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
          event.errored ? yellow(`${event.errored} errored`) : ''
        ].filter(Boolean)
        process.stdout.write(`\n${parts.join(dim(' - '))} ${dim(`in ${event.durationMs}ms`)}\n`)
        break
      }
    }
  })
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) {
    process.stderr.write(`${d.file}  ${d.path}\n  ${d.message}${d.hint ?? ''}\n`)
  }
  process.stderr.write(`\n${diagnostics.length} problem(s)\n`)
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
