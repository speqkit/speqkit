import { spawn } from 'node:child_process'
import { definePlugin, type CommandHost } from '@speqkit/plugin-api'
import { serve } from './server.js'

const EXIT_OK = 0
const EXIT_CONFIG = 2

interface UiConfig {
  /** The port to bind. 0 asks the operating system for a free one. */
  port?: number
  /** The interface to bind. Loopback by default, and see the README before changing it. */
  host?: string
  /** Open a browser when the server is up. True by default. */
  open?: boolean
}

/**
 * The project, in a browser.
 *
 * A suite in `.speq/` is a directory of YAML, and everything about it that is
 * not literally in the file is invisible: which plugin owns `browser.open`,
 * what its input is allowed to be, which suite a test inherits its tags from,
 * whether the thing has been red for a week or red once. Every one of those is
 * a question the running session can answer and a text editor cannot, and
 * until there is somewhere to ask them, the answer is to read our source.
 *
 * It is a plugin, the way `plugin-cli` is one, and that is the claim being
 * tested: a surface that is not the terminal costs nothing extra on the
 * contract. This reaches for exactly the verbs the CLI reaches for —
 * `discover`, `validate`, `capabilities`, `runs` — and not one thing more.
 *
 * Read-only, on purpose. `RunRequest` has no cancellation signal, so a Run
 * button in a browser would start something the browser cannot stop, against
 * a real system. The roadmap names that as the blocker for the stop button;
 * a start button without one is worse than neither.
 */
export default definePlugin({
  name: '@speqkit/plugin-ui',
  docs: {
    summary: 'serves the project in a browser: the suite tree, which plugin owns each step, diagnostics, and every recorded run',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-ui#readme',
    examples: [
      {
        title: 'looking at the project',
        summary: 'Binds loopback, opens a browser, and reads nothing outside .speq/.',
        for: ['ui'],
        code: [
          'speq ui',
          'speq ui --port 4000 --no-open'
        ].join('\n')
      },
      {
        title: 'reading a report somebody downloaded from CI',
        summary: 'A reports/ directory unpacked into the project is a run this can open, with its artifacts.',
        for: ['ui'],
        code: [
          'unzip speq-report.zip -d .speq/',
          'speq ui'
        ].join('\n')
      },
      {
        title: 'the defaults, if typing flags gets old',
        for: ['ui'],
        code: [
          '# speq.yaml',
          'ui:',
          '  port: 4000',
          '  open: false'
        ].join('\n')
      }
    ]
  },

  configSchema: {
    type: 'object',
    properties: {
      port: {
        type: 'integer',
        minimum: 0,
        maximum: 65535,
        description: 'the port to bind; 0 (the default) asks the operating system for a free one'
      },
      host: {
        type: 'string',
        description:
          'the interface to bind; 127.0.0.1 by default. This serves every test source and every recorded response body with no authentication, so anything else is a decision about your network'
      },
      open: {
        type: 'boolean',
        description: 'open a browser once the server is listening; true by default'
      }
    },
    additionalProperties: false
  },

  setup(ctx) {
    ctx.inject(['cli'], ({ cli }) => {
      const commands = cli as CommandHost

      commands.register('ui', {
        summary: 'open the project in a browser: tests, what each step is, and every run that happened',
        usage: 'speq ui [--port N] [--host ADDR] [--open|--no-open]',
        async run(argv) {
          const config = ctx.config<UiConfig>()
          const args = parse(argv)
          if (typeof args === 'string') {
            process.stderr.write(`${args}\n`)
            return EXIT_CONFIG
          }

          const address = args.host ?? config.host ?? '127.0.0.1'
          const port = args.port ?? config.port ?? 0
          const wantsBrowser = args.open ?? config.open ?? true

          const serving = await serve({ host: ctx.host, address, port })
          process.stdout.write(`speq ui: ${serving.url}\n`)
          if (address !== '127.0.0.1' && address !== 'localhost' && address !== '::1') {
            // Said out loud rather than refused: somebody port-forwarding from
            // a container has a reason. Somebody who typed `--host 0.0.0.0`
            // because a tutorial said to usually does not.
            process.stdout.write(
              `         bound to ${address}, so anyone who can reach this machine can read ` +
                `every test and every recorded response body.\n`
            )
          }
          process.stdout.write('         ctrl-c to stop\n')
          if (wantsBrowser) openBrowser(serving.url)

          // The command owns the process until somebody stops it, which is
          // what makes `speq ui` behave like every other server anyone runs.
          await new Promise<void>((resolve) => {
            const stop = (): void => {
              void serving.close().then(resolve)
            }
            process.once('SIGINT', stop)
            process.once('SIGTERM', stop)
          })
          return EXIT_OK
        }
      })
    })
  }
})

interface Args {
  port?: number
  host?: string
  open?: boolean
}

/**
 * Strict, like the rest of the command surface: an unknown flag is refused
 * rather than ignored, because a flag that is silently dropped is a setting
 * somebody believes is in effect.
 */
export function parse(argv: string[]): Args | string {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (flag === '--open') args.open = true
    else if (flag === '--no-open') args.open = false
    else if (flag === '--port' || flag === '--host') {
      const value = argv[++i]
      if (value === undefined) return `${flag} needs a value`
      if (flag === '--host') args.host = value
      else {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65535) return `--port wants 0-65535, not '${value}'`
        args.port = port
      }
    } else {
      return `unknown flag '${flag}'. Usage: speq ui [--port N] [--host ADDR] [--open|--no-open]`
    }
  }
  return args
}

/**
 * Opens the reader's browser, and never fails the command over it.
 *
 * There is no browser on a build agent and no `open` on a bare container, and
 * the URL is already on stdout — so a failure here costs nothing and a thrown
 * error would cost the whole command.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* the URL is printed above; that is the whole fallback anyone needs */
  }
}

export { serve, contained } from './server.js'
export type { ServeOptions, Serving } from './server.js'
export { readProject } from './project.js'
export type { ProjectDocument } from './project.js'
export { foldRun, historyOf, readEvents, summarise, artifactHref } from './runs.js'
export type {
  History, HistoryPoint, RunArtifact, RunAssertion, RunDocument, RunStep,
  RunSummary, RunTest, RunTotals
} from './runs.js'
export { page } from './app.js'
