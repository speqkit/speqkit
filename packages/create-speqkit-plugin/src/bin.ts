#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { relative } from 'node:path'
import { scaffold, type ScaffoldOptions } from './scaffold.js'

const USAGE = `create-speqkit-plugin — scaffold a speq plugin

  npm create speqkit-plugin <name>
  pnpm create speqkit-plugin <name>

  <name>              the plugin's short name: http, kafka, my-thing
                      the package becomes speqkit-plugin-<name>

  --dir <path>        where to write it (default: ./speqkit-plugin-<name>)
  --scope @acme       publish under a scope: @acme/speqkit-plugin-<name>
  --description <s>   one line, for package.json and the README
  --force             write into a directory that is not empty
  -h, --help          this
`

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }

  const options: Partial<ScaffoldOptions> = {}
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const take = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--dir') options.dir = take()
    else if (arg === '--scope') options.scope = take()
    else if (arg === '--description') options.description = take()
    else if (arg === '--force') options.force = true
    else if (arg.startsWith('-')) throw new Error(`unknown option '${arg}'\n\n${USAGE}`)
    else rest.push(arg)
  }

  if (rest.length > 1) throw new Error(`expected one name, got ${rest.length}: ${rest.join(' ')}`)

  // `npm create speqkit-plugin` with no argument is the common way in, so ask
  // — but only when there is someone there to answer. In CI a missing name is
  // a mistake, and a prompt would hang the job rather than fail it.
  const name = rest[0] ?? (process.stdin.isTTY ? await ask() : undefined)
  if (!name) throw new Error(`a plugin name is required.\n\n${USAGE}`)

  const result = scaffold({ ...options, name })
  const where = relative(process.cwd(), result.dir) || '.'

  process.stdout.write(
    `\nCreated ${result.packageName} in ${where}\n\n` +
      `  cd ${where}\n` +
      '  npm install\n' +
      '  npm test\n\n' +
      'Then open src/index.ts. The step type and the assertion in it are placeholders;\n' +
      'the schemas around them are not — they are how a bad test fails before it runs.\n'
  )
  return 0
}

async function ask(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('Plugin name (e.g. kafka): ')).trim()
  } finally {
    rl.close()
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (err: unknown) => {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
)
