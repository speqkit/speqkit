import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Store, readLock, parseSpec } from '@speqkit/installer'

export interface SpeqConfig {
  version: number
  plugins: string[]
  /** Per-plugin blocks, keyed by short name: `http`, `postgres`, … */
  settings: Record<string, unknown>
  /** Every file that contributed, nearest last. For diagnostics. */
  sources: string[]
  /** The environment layer applied on top, when one was asked for. */
  env?: string
}

export interface LoadOptions {
  /** Name of a file in `environments/`, without the extension. */
  env?: string
}

interface RawConfig {
  version?: number
  extends?: string | string[]
  plugins?: unknown
  [key: string]: unknown
}

const RESERVED = new Set(['version', 'extends', 'plugins'])

/**
 * Reads speq.yaml, flattens its `extends` chain, then applies one environment
 * file on top.
 *
 * `extends` is what keeps thirty microservices from drifting into thirty
 * different plugin sets: the platform team publishes one preset package and
 * bumps it in one place. It has to exist from the start — retrofitting it onto
 * a flat config later means rewriting every project's file.
 */
export function loadConfig(root: string, options: LoadOptions = {}): SpeqConfig {
  const file = join(root, 'speq.yaml')
  if (!existsSync(file)) {
    throw new Error(`no speq.yaml in ${root}; run 'speq init'`)
  }

  const merged: SpeqConfig = { version: 1, plugins: [], settings: {}, sources: [] }
  const seen = new Set<string>()
  applyFile(file, merged, seen, root)

  const env = options.env ?? process.env.SPEQ_ENV
  if (env) applyEnvironment(root, env, merged)

  if (merged.version !== 1) {
    throw new Error(`speq.yaml declares version ${merged.version}; this build understands version 1`)
  }
  return merged
}

/**
 * The local file only, with nothing flattened.
 *
 * `speq install` needs this: a preset is an npm package, so it has to be on
 * disk before the config that names it can be read at all. The installer runs
 * one pass over `extends` and then reads the real config.
 */
export function readRawConfig(root: string): { extends: string[]; plugins: string[] } {
  const file = join(root, 'speq.yaml')
  if (!existsSync(file)) throw new Error(`no speq.yaml in ${root}; run 'speq init'`)

  const raw = readConfigFile(file)
  const presets = raw.extends ? (Array.isArray(raw.extends) ? raw.extends : [raw.extends]) : []
  return { extends: presets.filter((p) => typeof p === 'string'), plugins: normalisePlugins(raw.plugins, file) }
}

/* ------------------------------------------------------------------ */
/* Environments                                                        */
/* ------------------------------------------------------------------ */

/**
 * An environment tunes settings and nothing else.
 *
 * It deliberately cannot add plugins or `extends`. The plugin set is what
 * `speq.lock` pins, and `speq install --frozen` runs in CI without being told
 * which environment the later `speq run` will pick — so an environment able to
 * introduce a plugin could produce a lock that is correct for `local` and short
 * by one package for `ci`. Keeping the two apart is what makes `--frozen` mean
 * anything.
 */
function applyEnvironment(root: string, name: string, out: SpeqConfig): void {
  const file = environmentFile(root, name)
  const raw = readConfigFile(file)

  for (const key of ['plugins', 'extends'] as const) {
    if (raw[key] !== undefined) {
      throw new Error(
        `${file}: an environment cannot set '${key}'. ` +
          `The plugin set is pinned by speq.lock and must not depend on which environment runs; ` +
          `move it to speq.yaml.`
      )
    }
  }

  mergeSettings(raw, out)
  out.sources.push(file)
  out.env = name
}

function environmentFile(root: string, name: string): string {
  const dir = join(root, 'environments')
  for (const ext of ['.yaml', '.yml']) {
    const file = join(dir, `${name}${ext}`)
    if (existsSync(file)) return file
  }
  throw new Error(
    `no environment '${name}' in ${dir}${listEnvironments(dir)}`
  )
}

function listEnvironments(dir: string): string {
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.ya?ml$/, ''))
      .sort()
  } catch {
    return `. The directory does not exist; create it and add ${dir}/local.yaml`
  }
  return names.length ? `. Available: ${names.join(', ')}` : `. The directory is empty`
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

function applyFile(file: string, out: SpeqConfig, seen: Set<string>, root: string): void {
  const key = resolve(file)
  if (seen.has(key)) {
    throw new Error(`circular 'extends' involving ${file}`)
  }
  seen.add(key)

  const raw = readConfigFile(file)

  // Presets first, so the local file wins on conflicts.
  const parents = raw.extends ? (Array.isArray(raw.extends) ? raw.extends : [raw.extends]) : []
  for (const parent of parents) {
    applyFile(resolvePreset(parent, dirname(file), root), out, seen, root)
  }

  if (typeof raw.version === 'number') out.version = raw.version
  for (const name of normalisePlugins(raw.plugins, file)) {
    if (!out.plugins.includes(name)) out.plugins.push(name)
  }
  mergeSettings(raw, out)
  out.sources.push(file)
}

function mergeSettings(raw: RawConfig, out: SpeqConfig): void {
  for (const [k, v] of Object.entries(raw)) {
    if (RESERVED.has(k)) continue
    out.settings[k] = isPlainObject(v) && isPlainObject(out.settings[k])
      ? { ...(out.settings[k] as object), ...v }
      : v
  }
}

function readConfigFile(file: string): RawConfig {
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(file, 'utf8')) ?? {}
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return expandEnv(raw, file) as RawConfig
}

const ENV_TEMPLATE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Substitutes `${env:NAME}` and `${env:NAME:-fallback}` anywhere in a config
 * file. Nothing else is touched: `${login.body.id}` is a step reference and
 * belongs to the run, not to the config, so it has to survive verbatim.
 *
 * An unset variable with no fallback is an error rather than an empty string.
 * In CI the alternative is a suite that quietly points at `http://` and passes
 * against nothing.
 */
function expandEnv<T>(value: T, file: string): T {
  if (typeof value === 'string') {
    return value.replace(ENV_TEMPLATE, (_m, name: string, fallback?: string) => {
      const found = process.env[name]
      if (found !== undefined) return found
      if (fallback !== undefined) return fallback
      throw new Error(
        `${file}: \${env:${name}} is not set in the environment. ` +
          `Export it, or write \${env:${name}:-default} to make it optional.`
      )
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, file)) as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, file)
    return out as T
  }
  return value
}

function normalisePlugins(value: unknown, file: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`${file}: 'plugins' must be a list`)
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`${file}: every entry in 'plugins' must be a string`)
    }
    return entry
  })
}

/** A preset is an ordinary package, a relative path, or an absolute path. */
function resolvePreset(spec: string, from: string, root: string): string {
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const path = isAbsolute(spec) ? spec : resolve(from, spec)
    return existsSync(path) && !path.endsWith('.yaml') ? join(path, 'speq.yaml') : path
  }

  const fromStore = presetInStore(spec, root)
  if (fromStore) return fromStore

  const require = createRequire(join(from, 'noop.js'))
  try {
    return require.resolve(`${spec}/speq.yaml`)
  } catch {
    throw new Error(
      `cannot resolve preset '${spec}' from ${from}. ` +
        `Run 'speq install' — a preset is an ordinary package and has to be fetched like one.`
    )
  }
}

function presetInStore(spec: string, root: string): string | undefined {
  let lock
  try {
    lock = readLock(root)
  } catch {
    return undefined
  }
  const name = parseSpec(spec).name
  const entry = lock?.presets.find((p) => p.spec === spec || p.name === name)
  if (!entry) return undefined

  const file = join(new Store().pathFor(entry.name, entry.version), 'speq.yaml')
  return existsSync(file) ? file : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
