#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store, addLink, readLinks, readLock, removeLink, install, type InstallEvent } from '@speqkit/installer'
import type { Capabilities, Capability, CommandHost, Example } from '@speqkit/plugin-api'
import { bootstrap } from './bootstrap.js'
import { capabilitiesOf } from './host.js'
import { shortName } from './registry.js'
import { discoverRoot } from './discovery.js'
import { loadConfig, readRawConfig } from './config.js'
import { StartupError, startupFailure } from './errors.js'
import { addPluginToConfig, removePluginFromConfig } from './edit-config.js'

/**
 * The bootstrap owns exactly the commands that must work *before* plugins are
 * loaded — otherwise there would be no way to install the plugin that provides
 * them. Everything else, `run` included, is contributed by a plugin and simply
 * does not exist when that plugin is not loaded.
 */
const BOOTSTRAP_COMMANDS = new Set([
  'init', 'install', 'add', 'remove', 'link', 'unlink', 'plugins', 'docs', 'doctor', 'help', 'version'
])

/**
 * Kept in step with packages/core/package.json by a test, because a literal
 * here is exactly the kind of thing that is right on the day it is written
 * and wrong at the next release. It stays a literal rather than a read of
 * package.json: inside the standalone binary there is no package.json to read.
 */
const VERSION = '0.5.0'

const EXIT_OK = 0
const EXIT_CONFIG = 2

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  const rest = argv.slice(1)

  if (!command || command === 'help' || command === '--help' || command === '-h') return usage()
  if (command === 'version' || command === '--version' || command === '-V') {
    process.stdout.write(`speq ${VERSION} (plugin-api v1)\n`)
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
  if (command === 'docs') return commandDocs(session, rest)
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
      `  speq docs [<name>] [--json|--check]    what it is for, with examples to paste\n` +
      `  speq doctor                            environment, store and compatibility\n` +
      `  speq version\n\n` +
      `Everything else comes from plugins. With '@speqkit/plugin-cli' loaded:\n` +
      `  speq run [--env <name>] [--reporter a,b] [--json]\n` +
      `  speq report [--run <id>] [--list]     re-render a finished run\n` +
      `  speq validate | speq list             add --json for a document\n` +
      `  speq capabilities                     what may be written, with schemas\n` +
      `And with '@speqkit/plugin-use':\n` +
      `  speq modules                          the blocks and actions this project has\n`
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

  // The sample is a starting point, not a fixture. Beside a suite that already
  // exists — the v1 tree `speq migrate` is about to rewrite — it is litter.
  const empty = readdirSync(join(root, 'suites')).length === 0

  writeFileSync(
    join(root, 'speq.yaml'),
    `version: 1\n\n` +
      `plugins:\n  - yaml\n  - http\n  - cli\n  - junit\n\n` +
      `http:\n  baseUrl: http://localhost:8080\n`
  )
  if (empty) {
    writeFileSync(
      join(root, 'suites', 'health.yaml'),
      `name: service is up\ntags: [smoke]\n\n` +
        `steps:\n  - id: health\n    type: http\n    method: GET\n    url: /health\n\n` +
        `assert:\n  - type: status\n    expected: 200\n`
    )
  }
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

/* ------------------------------------------------------------------ */
/* docs                                                                */
/* ------------------------------------------------------------------ */

/**
 * What a plugin is for, and what using it looks like.
 *
 * `speq plugins` answers who is loaded. `speq capabilities` answers what may be
 * written, with the schemas. Neither answers the question somebody actually has
 * a minute after `speq add`: what is this for, and what does one line of it look
 * like. That answer lived in a README on a website — a document this session
 * cannot ask, cannot check, and which goes wrong silently the moment a step
 * type is renamed.
 *
 * It is a bootstrap command beside `plugins` and `doctor` rather than a
 * contributed one, because it is asked *about* the installation: a project
 * whose command surface is not loaded is exactly a project whose owner needs
 * to find out what is installed and how to reach it.
 *
 * `--json` is the same facts arranged for a reader rather than for a checker:
 * grouped by plugin, each with its own capabilities and examples inline, so a
 * model writing a suite gets the vocabulary and a working line of each in one
 * call instead of two documents it has to join.
 */
function commandDocs(session: Awaited<ReturnType<typeof bootstrap>>, argv: string[]): number {
  const capabilities = capabilitiesOf(session.registry)
  const entries = groupByPlugin(capabilities)
  if (argv.includes('--check')) return checkDocs(entries)

  const json = argv.includes('--json')
  const subject = positional(argv)

  if (subject === undefined) {
    if (json) writeJson({ apiVersion: capabilities.apiVersion, plugins: entries })
    else printDocsIndex(session, entries)
    return EXIT_OK
  }

  const plugin = entries.find((e) => e.name === subject || shortName(e.name) === subject)
  if (plugin) {
    if (json) writeJson(plugin)
    else printPluginDocs(plugin)
    return EXIT_OK
  }

  const found = findCapability(entries, subject)
  if (!found) {
    const known = [...new Set([
      ...entries.map((e) => shortName(e.name)),
      ...entries.flatMap((e) => e.contributes.map((c) => c.name))
    ])].sort()
    process.stderr.write(
      `nothing loaded is called '${subject}'.\n` +
        `Known: ${known.join(', ')}\n` +
        `A plugin that is installed but not listed in speq.yaml is not loaded, and cannot be asked.\n`
    )
    return EXIT_CONFIG
  }
  if (json) writeJson(found)
  else printCapabilityDocs(found)
  return EXIT_OK
}

/** One plugin, with everything it brought and everything it says. */
interface PluginEntry {
  name: string
  version?: string
  origin?: string
  summary?: string
  readme?: string
  contributes: (Capability & { kind: string; prefix?: string; extensions?: string[] })[]
  examples: Example[]
}

function groupByPlugin(capabilities: Capabilities): PluginEntry[] {
  const kinds: [string, Capability[]][] = [
    ['step', capabilities.stepTypes],
    ['assertion', capabilities.assertions],
    ['provider', capabilities.valueProviders],
    ['reporter', capabilities.reporters],
    ['loader', capabilities.loaders]
  ]
  return capabilities.plugins.map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    origin: plugin.origin,
    summary: plugin.docs?.summary,
    readme: plugin.docs?.readme,
    contributes: kinds.flatMap(([kind, list]) =>
      list.filter((c) => c.plugin === plugin.name).map((c) => ({ ...c, kind }))
    ),
    examples: plugin.docs?.examples ?? []
  }))
}

interface Found {
  capability: PluginEntry['contributes'][number]
  plugin: PluginEntry
  examples: Example[]
}

/**
 * An example says which capabilities it demonstrates, so looking one up is a
 * lookup and not a search through prose. A provider is found by its prefix as
 * well as by its name — `${gen:uuid}` is what somebody has in front of them
 * when they come asking.
 */
function findCapability(entries: PluginEntry[], subject: string): Found | undefined {
  for (const plugin of entries) {
    const capability = plugin.contributes.find((c) => c.name === subject || c.prefix === subject)
    if (!capability) continue
    return {
      capability,
      plugin,
      examples: entries.flatMap((e) => e.examples.filter((x) => x.for?.includes(capability.name)))
    }
  }
  return undefined
}

function printDocsIndex(
  session: Awaited<ReturnType<typeof bootstrap>>,
  entries: PluginEntry[]
): void {
  process.stdout.write(`root: ${session.root.root} (${session.root.mode})\n\n`)
  for (const plugin of entries) {
    const origin = plugin.origin ? `${plugin.origin}${plugin.version ? ` ${plugin.version}` : ''}` : ''
    process.stdout.write(`  ${plugin.name.padEnd(30)} ${origin}\n`)
    process.stdout.write(
      plugin.summary
        ? `      ${plugin.summary}\n`
        : `      (says nothing about itself — see 'speq docs --check')\n`
    )
    for (const [kind, list] of byKind(plugin.contributes)) {
      process.stdout.write(`      ${`${kind}s:`.padEnd(12)}${list.map((c) => c.name).join(', ')}\n`)
    }
    if (plugin.readme) process.stdout.write(`      ${plugin.readme}\n`)
  }

  const examples = entries.reduce((n, e) => n + e.examples.length, 0)
  process.stdout.write(
    `\n${entries.length} plugin(s), ` +
      `${entries.reduce((n, e) => n + e.contributes.length, 0)} capability(ies), ` +
      `${examples} example(s)\n` +
      `  speq docs <plugin|step|assertion|prefix>   one entry, with its examples in full\n` +
      `  speq docs --json                           the same, for something that is not a person\n` +
      `  speq docs --check                          what a reader here cannot find out\n`
  )
}

function printPluginDocs(plugin: PluginEntry): void {
  const origin = plugin.origin ? `${plugin.origin}${plugin.version ? ` ${plugin.version}` : ''}` : ''
  process.stdout.write(`${plugin.name}  ${origin}\n`)
  if (plugin.summary) process.stdout.write(`${plugin.summary}\n`)
  if (plugin.readme) process.stdout.write(`\nreadme: ${plugin.readme}\n`)

  const grouped = byKind(plugin.contributes)
  if (grouped.length > 0) {
    process.stdout.write(`\ncontributes\n`)
    for (const [kind, list] of grouped) {
      for (const capability of list) {
        process.stdout.write(`  ${kind.padEnd(10)} ${capability.name.padEnd(18)} ${capability.summary ?? ''}\n`)
      }
    }
  }
  printExamples(plugin.examples)
}

function printCapabilityDocs(found: Found): void {
  const { capability, plugin } = found
  const article = 'aeiou'.includes(capability.kind[0]!) ? 'an' : 'a'
  process.stdout.write(`${capability.name} — ${article} ${capability.kind} from ${plugin.name}\n`)
  if (capability.summary) process.stdout.write(`${capability.summary}\n`)
  if (capability.prefix) process.stdout.write(`\nwritten as \${${capability.prefix}:key}\n`)
  if (capability.extensions?.length) {
    process.stdout.write(`\nreads ${capability.extensions.join(', ')}\n`)
  }

  const properties = capability.schema?.properties
  if (properties && Object.keys(properties).length > 0) {
    const required = new Set(capability.schema?.required ?? [])
    process.stdout.write(`\nfields\n`)
    for (const [field, shape] of Object.entries(properties)) {
      const type = (shape as { type?: string }).type ?? 'any'
      process.stdout.write(`  ${required.has(field) ? '*' : ' '} ${field.padEnd(18)} ${type}\n`)
    }
    process.stdout.write(`  (* required)\n`)
  }

  if (found.examples.length === 0 && plugin.readme) {
    process.stdout.write(`\nNo example names it. The prose is at ${plugin.readme}\n`)
  }
  printExamples(found.examples)
}

function printExamples(examples: Example[]): void {
  if (examples.length === 0) return
  process.stdout.write(`\nexamples\n`)
  for (const example of examples) {
    process.stdout.write(`\n  ${example.title}\n`)
    if (example.summary) process.stdout.write(`  ${example.summary}\n`)
    for (const line of example.code.replace(/\s+$/, '').split('\n')) {
      process.stdout.write(`    ${line}\n`)
    }
  }
}

/**
 * What a reader of this project cannot find out, and whose fault that is.
 *
 * A plugin saying nothing about itself is an error rather than a note: it is
 * the state the whole command exists to remove, and the one that a plugin's own
 * author is the only person able to fix. A dead name in an example's `for` is
 * an error for a sharper reason — it is what a renamed step type leaves behind,
 * and the only mechanism here that catches documentation rotting.
 *
 * A capability no example demonstrates is reported and changes nothing. Some
 * genuinely need none, and turning that into a failure would push authors to
 * write an example per entry rather than an example worth reading.
 */
function checkDocs(entries: PluginEntry[]): number {
  const known = new Set(entries.flatMap((e) => e.contributes.flatMap((c) => [c.name, ...(c.prefix ? [c.prefix] : [])])))
  const problems: string[] = []
  const notes: string[] = []

  for (const plugin of entries) {
    if (!plugin.summary) {
      problems.push(`${plugin.name}: declares no docs — nobody who installs it can be told what it is for`)
      continue
    }
    if (plugin.examples.length === 0) {
      problems.push(`${plugin.name}: declares docs with no examples`)
    }
    for (const example of plugin.examples) {
      for (const name of example.for ?? []) {
        if (!known.has(name)) {
          problems.push(
            `${plugin.name}: example '${example.title}' says it shows '${name}', ` +
              `which nothing loaded defines`
          )
        }
      }
    }
    const shown = new Set(plugin.examples.flatMap((x) => x.for ?? []))
    for (const capability of plugin.contributes) {
      if (!shown.has(capability.name)) notes.push(`${plugin.name}: ${capability.kind} '${capability.name}'`)
    }
  }

  for (const problem of problems) process.stderr.write(`  ${problem}\n`)
  if (notes.length > 0) {
    process.stdout.write(`${notes.length} capability(ies) no example demonstrates:\n`)
    for (const note of notes) process.stdout.write(`  ${note}\n`)
  }
  process.stdout.write(
    problems.length === 0
      ? `\n${entries.length} plugin(s) checked, all of them say what they are for\n`
      : `\n${problems.length} problem(s)\n`
  )
  return problems.length === 0 ? EXIT_OK : EXIT_CONFIG
}

function byKind(
  contributes: PluginEntry['contributes']
): [string, PluginEntry['contributes']][] {
  const groups = new Map<string, PluginEntry['contributes']>()
  for (const capability of contributes) {
    const list = groups.get(capability.kind) ?? []
    list.push(capability)
    groups.set(capability.kind, list)
  }
  return [...groups]
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The first argument that is not a flag and is not a flag's value.
 *
 * `--speq-root` and `--env` take one, and `speq docs --env staging` naming the
 * environment as the subject would be a confusing way to be told nothing is
 * called 'staging'.
 */
function positional(argv: string[]): string | undefined {
  const takesValue = new Set(['--speq-root', '--env'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (takesValue.has(arg)) { i++; continue }
    if (!arg.startsWith('-')) return arg
  }
  return undefined
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
    // A refusal to start is a fact about the *project*, so under `--json` it
    // goes to stdout as a document — the same line `plugin-cli` draws inside
    // a run, where a malformed `--shard` stays prose on stderr because a
    // caller that wrote it has a bug in itself rather than a result to read.
    // Without this, `speq run --json` answered a wrong speq.yaml with an
    // empty stdout, and the script parsing it fell over somewhere else.
    //
    // Anything that is not a `StartupError` has no code because it is a crash
    // rather than a refusal, and a crash has no document to offer.
    if (err instanceof StartupError && process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(startupFailure(err), null, 2)}\n`)
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    }
    process.exit(EXIT_CONFIG)
  })

export { discoverRoot }
