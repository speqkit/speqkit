#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandHost } from '@speq/plugin-api'
import { bootstrap } from './bootstrap.js'
import { discoverRoot } from './discovery.js'

/**
 * The bootstrap owns exactly the commands that must work *before* plugins are
 * loaded — otherwise there would be no way to install the plugin that provides
 * them. Everything else, `run` included, is contributed by a plugin and simply
 * does not exist when that plugin is not loaded.
 */
const BOOTSTRAP_COMMANDS = new Set(['init', 'plugins', 'doctor', 'help', 'version'])

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_CONFIG = 2

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  const rest = argv.slice(1)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return usage()
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    process.stdout.write('speq 0.1.0 (plugin-api v1)\n')
    return EXIT_OK
  }
  if (command === 'init') return commandInit(rest)

  const session = await bootstrap(flag(rest, '--speq-root'))

  if (command === 'plugins') return commandPlugins(session)
  if (command === 'doctor') return commandDoctor(session)

  const cli = session.registry.service('cli') as CommandHost | undefined
  const contributed = cli?.commands.get(command)
  if (!contributed) {
    const available = cli ? [...cli.commands.keys()] : []
    process.stderr.write(
      available.length
        ? `unknown command '${command}'. Available: ${[...BOOTSTRAP_COMMANDS, ...available].sort().join(', ')}\n`
        : `unknown command '${command}'. No command surface is loaded — add a plugin such as '@speq/plugin-cli'.\n`
    )
    return EXIT_CONFIG
  }
  return contributed.run(rest)
}

function usage(): number {
  process.stdout.write(
    `speq — a test framework that is mostly plugins\n\n` +
      `Bootstrap commands (always available):\n` +
      `  speq init [--mode in-repo|test-repo]   scaffold a project\n` +
      `  speq plugins                           what is loaded and what it contributes\n` +
      `  speq doctor                            environment and compatibility\n` +
      `  speq version\n\n` +
      `Everything else comes from plugins. With '@speq/plugin-cli' loaded:\n` +
      `  speq run | speq validate | speq list\n`
  )
  return EXIT_OK
}

function commandInit(argv: string[]): number {
  const mode = flag(argv, '--mode') ?? 'in-repo'
  if (mode !== 'in-repo' && mode !== 'test-repo') {
    process.stderr.write(`--mode must be 'in-repo' or 'test-repo'\n`)
    return EXIT_CONFIG
  }
  const root = mode === 'in-repo' ? join(process.cwd(), '.speq') : process.cwd()

  if (existsSync(join(root, 'speq.yaml'))) {
    process.stderr.write(`${join(root, 'speq.yaml')} already exists; nothing written\n`)
    return EXIT_CONFIG
  }

  mkdirSync(join(root, 'suites'), { recursive: true })
  mkdirSync(join(root, 'environments'), { recursive: true })

  writeFileSync(
    join(root, 'speq.yaml'),
    `version: 1\n\n` +
      `plugins:\n  - yaml\n  - http\n  - cli\n\n` +
      `http:\n  baseUrl: http://localhost:8080\n`
  )
  writeFileSync(
    join(root, 'suites', 'health.yaml'),
    `name: service is up\ntags: [smoke]\n\n` +
      `steps:\n  - id: health\n    type: http\n    method: GET\n    url: /health\n\n` +
      `assert:\n  - type: status\n    expected: 200\n`
  )

  process.stdout.write(
    `created ${mode} project at ${root}\n` +
      `  speq.yaml\n  suites/health.yaml\n\nNext: speq validate && speq run\n`
  )
  return EXIT_OK
}

function commandPlugins(session: Awaited<ReturnType<typeof bootstrap>>): number {
  const { registry } = session
  process.stdout.write(`root: ${session.root.root} (${session.root.mode})\n\n`)

  for (const name of registry.loadedPlugins()) {
    const contributions: string[] = []
    const collect = (label: string, entries: Iterable<[string, { owner: string }]>) => {
      const mine = [...entries].filter(([, e]) => e.owner === name).map(([k]) => k)
      if (mine.length) contributions.push(`${label}: ${mine.join(', ')}`)
    }
    collect('steps', registry.stepTypes)
    collect('assertions', registry.assertions)
    collect('reporters', registry.reporters)
    collect('loaders', registry.loaders)
    collect('providers', registry.valueProviders)

    process.stdout.write(`  ${name}\n`)
    for (const line of contributions) process.stdout.write(`      ${line}\n`)
    if (!contributions.length) process.stdout.write(`      (services only)\n`)
  }
  return EXIT_OK
}

function commandDoctor(session: Awaited<ReturnType<typeof bootstrap>>): number {
  const { registry, config, root } = session
  process.stdout.write(
    `node             ${process.version}\n` +
      `plugin-api       v1\n` +
      `root             ${root.root} (${root.mode})\n` +
      `config sources   ${config.sources.length}\n`
  )
  for (const source of config.sources) process.stdout.write(`                 ${source}\n`)
  process.stdout.write(
    `plugins          ${registry.loadedPlugins().length} loaded\n` +
      `step types       ${registry.stepTypes.size}\n` +
      `assertions       ${registry.assertions.size}\n` +
      `loaders          ${registry.loaders.size}\n`
  )
  if (registry.loaders.size === 0) {
    process.stdout.write(`\n  warning: no loader registered — no test file can be read\n`)
  }
  return EXIT_OK
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(EXIT_CONFIG)
  })

export { discoverRoot }
