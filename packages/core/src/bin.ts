#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandHost } from '@speqkit/plugin-api'
import { Store, addLink, readLinks, readLock, removeLink, install, type InstallEvent } from '@speqkit/installer'
import { bootstrap } from './bootstrap.js'
import { discoverRoot } from './discovery.js'
import { loadConfig, readRawConfig } from './config.js'
import { addPluginToConfig, removePluginFromConfig } from './edit-config.js'

/**
 * The bootstrap owns exactly the commands that must work *before* plugins are
 * loaded — otherwise there would be no way to install the plugin that provides
 * them. Everything else, `run` included, is contributed by a plugin and simply
 * does not exist when that plugin is not loaded.
 */
const BOOTSTRAP_COMMANDS = new Set([
  'init', 'install', 'add', 'remove', 'link', 'unlink', 'plugins', 'doctor', 'help', 'version'
])

const EXIT_OK = 0
const EXIT_CONFIG = 2

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  const rest = argv.slice(1)

  if (!command || command === 'help' || command === '--help' || command === '-h') return usage()
  if (command === 'version' || command === '--version' || command === '-V') {
    process.stdout.write('speq 0.1.0 (plugin-api v1)\n')
    return EXIT_OK
  }

  if (command === 'init') return commandInit(rest)
  if (command === 'install') return commandInstall(rest)
  if (command === 'add') return commandAdd(rest)
  if (command === 'remove') return commandRemove(rest)
  if (command === 'link') return commandLink(rest)
  if (command === 'unlink') return commandUnlink(rest)

  const session = await bootstrap({ root: flag(rest, '--speq-root'), env: flag(rest, '--env') })

  if (command === 'plugins') return commandPlugins(session)
  if (command === 'doctor') return commandDoctor(session)

  const cli = session.registry.service('cli') as CommandHost | undefined
  const contributed = cli?.commands.get(command)
  if (!contributed) {
    const available = cli ? [...cli.commands.keys()] : []
    process.stderr.write(
      available.length
        ? `unknown command '${command}'. Available: ${[...BOOTSTRAP_COMMANDS, ...available].sort().join(', ')}\n`
        : `unknown command '${command}'. No command surface is loaded — add a plugin such as '@speqkit/plugin-cli'.\n`
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
      `  speq install [--frozen]                fetch the plugins speq.yaml asks for\n` +
      `  speq add <plugin>...                   add to speq.yaml and install\n` +
      `  speq remove <plugin>...                remove from speq.yaml and install\n` +
      `  speq link <path>                       use a plugin you are developing\n` +
      `  speq unlink <name>                     stop using it\n` +
      `  speq plugins                           what is loaded and what it contributes\n` +
      `  speq doctor                            environment, store and compatibility\n` +
      `  speq version\n\n` +
      `Everything else comes from plugins. With '@speqkit/plugin-cli' loaded:\n` +
      `  speq run [--env <name>] [--reporter a,b]\n` +
      `  speq report [--run <id>] [--list]     re-render a finished run\n` +
      `  speq validate | speq list\n`
  )
  return EXIT_OK
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

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
      `plugins:\n  - yaml\n  - http\n  - cli\n  - junit\n\n` +
      `http:\n  baseUrl: http://localhost:8080\n`
  )
  writeFileSync(
    join(root, 'suites', 'health.yaml'),
    `name: service is up\ntags: [smoke]\n\n` +
      `steps:\n  - id: health\n    type: http\n    method: GET\n    url: /health\n\n` +
      `assert:\n  - type: status\n    expected: 200\n`
  )
  // Two environments, because one environment teaches nothing. What differs
  // between them is settings and only settings — see applyEnvironment().
  writeFileSync(
    join(root, 'environments', 'local.yaml'),
    `# Applied on top of speq.yaml by 'speq run --env local'.\n` +
      `# Settings only: the plugin set is pinned by speq.lock and must not\n` +
      `# depend on which environment happens to run.\n\n` +
      `http:\n  baseUrl: http://localhost:8080\n`
  )
  writeFileSync(
    join(root, 'environments', 'ci.yaml'),
    `# 'speq run --env ci'. The URL comes from the CI environment, and the\n` +
      `# run fails loudly when it is missing rather than quietly testing\n` +
      `# localhost. Write \${env:BASE_URL:-http://localhost:8080} to make it\n` +
      `# optional instead.\n\n` +
      `http:\n  baseUrl: \${env:BASE_URL}\n`
  )
  writeFileSync(
    join(root, '.gitignore'),
    `# Run output and machine-local links. speq.lock is committed.\nreports/\nlinks.yaml\n`
  )

  process.stdout.write(
    `created ${mode} project at ${root}\n` +
      `  speq.yaml\n  suites/health.yaml\n` +
      `  environments/local.yaml\n  environments/ci.yaml\n  .gitignore\n\n` +
      `Next: speq install && speq run --env local\n`
  )
  return EXIT_OK
}

/* ------------------------------------------------------------------ */
/* install, add, remove                                                */
/* ------------------------------------------------------------------ */

async function commandInstall(argv: string[]): Promise<number> {
  const root = discoverRoot(flag(argv, '--speq-root')).root
  const frozen = argv.includes('--frozen')

  const result = await install({
    root,
    frozen,
    presets: () => readRawConfig(root).extends,
    // Read only once the presets are on disk: they decide what this returns.
    plugins: () => loadConfig(root).plugins,
    onEvent: printInstallEvent
  })

  const downloaded = result.packages.filter((p) => p.source === 'downloaded').length
  process.stdout.write(
    `\n${result.packages.length} package(s), ${downloaded} downloaded, ` +
      `${result.packages.length - downloaded} from cache\n`
  )
  if (frozen) process.stdout.write(`lock verified, nothing written\n`)
  return EXIT_OK
}

async function commandAdd(argv: string[]): Promise<number> {
  const root = discoverRoot(flag(argv, '--speq-root')).root
  const specs = argv.filter((a) => !a.startsWith('--') && a !== flag(argv, '--speq-root'))
  if (specs.length === 0) {
    process.stderr.write(`usage: speq add <plugin>[@version]...\n`)
    return EXIT_CONFIG
  }

  for (const spec of specs) {
    const { added, file } = addPluginToConfig(root, spec)
    process.stdout.write(added ? `added ${spec} to ${file}\n` : `${spec} is already in ${file}\n`)
  }
  return commandInstall(argv.filter((a) => !specs.includes(a)))
}

async function commandRemove(argv: string[]): Promise<number> {
  const root = discoverRoot(flag(argv, '--speq-root')).root
  const specs = argv.filter((a) => !a.startsWith('--') && a !== flag(argv, '--speq-root'))
  if (specs.length === 0) {
    process.stderr.write(`usage: speq remove <plugin>...\n`)
    return EXIT_CONFIG
  }

  let changed = false
  for (const spec of specs) {
    const { removed, file } = removePluginFromConfig(root, spec)
    if (removed) {
      changed = true
      process.stdout.write(`removed ${removed} from ${file}\n`)
    } else {
      process.stdout.write(`${spec} is not in ${file}\n`)
    }
  }
  // The store is shared and content-addressed: nothing is deleted here. A
  // plugin removed from one project is still cached for the next one.
  return changed ? commandInstall(argv.filter((a) => !specs.includes(a))) : EXIT_OK
}

function printInstallEvent(event: InstallEvent): void {
  switch (event.type) {
    case 'resolving':
      process.stdout.write(`resolving ${event.specs} plugin(s)\n`)
      break
    case 'package':
      process.stdout.write(`  ${event.name.padEnd(32)} ${event.version.padEnd(10)} ${event.source}\n`)
      break
    case 'linked':
      process.stdout.write(`  ${event.name.padEnd(32)} ${'linked'.padEnd(10)} ${event.path}\n`)
      break
    case 'warning':
      process.stderr.write(`  note: ${event.message}\n`)
      break
    case 'lock':
      process.stdout.write(event.changed ? `  ${event.file} updated\n` : `  ${event.file} unchanged\n`)
      break
  }
}

/* ------------------------------------------------------------------ */
/* link                                                                */
/* ------------------------------------------------------------------ */

function commandLink(argv: string[]): number {
  const root = discoverRoot(flag(argv, '--speq-root')).root
  const path = argv.find((a) => !a.startsWith('--') && a !== flag(argv, '--speq-root'))

  if (!path) {
    const links = readLinks(root)
    if (Object.keys(links).length === 0) {
      process.stdout.write(`nothing linked\n`)
      return EXIT_OK
    }
    for (const [name, target] of Object.entries(links)) process.stdout.write(`${name}  ${target}\n`)
    return EXIT_OK
  }

  const { name, path: target } = addLink(root, path)
  process.stdout.write(
    `linked ${name} -> ${target}\n` +
      `It now wins over the store and over node_modules. 'speq unlink ${name}' to stop.\n`
  )
  return EXIT_OK
}

function commandUnlink(argv: string[]): number {
  const root = discoverRoot(flag(argv, '--speq-root')).root
  const name = argv.find((a) => !a.startsWith('--') && a !== flag(argv, '--speq-root'))
  if (!name) {
    process.stderr.write(`usage: speq unlink <plugin-name>\n`)
    return EXIT_CONFIG
  }
  const removed = removeLink(root, name)
  process.stdout.write(removed ? `unlinked ${name}\n` : `${name} was not linked\n`)
  return EXIT_OK
}

/* ------------------------------------------------------------------ */
/* plugins, doctor                                                     */
/* ------------------------------------------------------------------ */

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

    const source = registry.sources.get(name)
    const origin = source ? `${source.origin}${source.version ? ` ${source.version}` : ''}` : ''
    process.stdout.write(`  ${name.padEnd(30)} ${origin}\n`)
    for (const line of contributions) process.stdout.write(`      ${line}\n`)
    if (!contributions.length) process.stdout.write(`      (services only)\n`)
  }
  return EXIT_OK
}

function commandDoctor(session: Awaited<ReturnType<typeof bootstrap>>): number {
  const { registry, config, root } = session
  const store = new Store()
  const lock = readLock(root.root)
  const links = readLinks(root.root)

  process.stdout.write(
    `node             ${process.version}\n` +
      `plugin-api       v1\n` +
      `root             ${root.root} (${root.mode})\n` +
      `store            ${store.root} (${store.contents().length} package(s))\n` +
      `lock             ${lock ? `${lock.plugins.length} plugin(s), ${Object.keys(lock.packages).length} package(s)` : 'none — run speq install'}\n` +
      `links            ${Object.keys(links).length}\n` +
      `config sources   ${config.sources.length}\n`
  )
  for (const source of config.sources) process.stdout.write(`                 ${source}\n`)
  process.stdout.write(
    `environment      ${config.env ?? 'none — pass --env or set SPEQ_ENV'}\n` +
      `environments     ${environmentNames(root.root) || '(none)'}\n` +
      `plugins          ${registry.loadedPlugins().length} loaded\n` +
      `step types       ${registry.stepTypes.size}\n` +
      `assertions       ${registry.assertions.size}\n` +
      `reporters        ${[...registry.reporters.keys()].sort().join(', ') || '(none)'}\n` +
      `loaders          ${registry.loaders.size}\n`
  )

  const unlocked = registry
    .loadedPlugins()
    .filter((name) => registry.sources.get(name)?.origin === 'node_modules')
  if (unlocked.length > 0) {
    process.stdout.write(
      `\n  note: ${unlocked.length} plugin(s) came from node_modules, not from the lock:\n` +
        unlocked.map((n) => `        ${n}\n`).join('') +
        `        CI will not reproduce this. Run 'speq install'.\n`
    )
  }
  if (registry.loaders.size === 0) {
    process.stdout.write(`\n  warning: no loader registered — no test file can be read\n`)
  }
  return EXIT_OK
}

function environmentNames(root: string): string {
  try {
    return readdirSync(join(root, 'environments'))
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.ya?ml$/, ''))
      .sort()
      .join(', ')
  } catch {
    return ''
  }
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
