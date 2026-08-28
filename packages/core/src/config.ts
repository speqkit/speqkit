import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Store, readLock, parseSpec } from '@speq/installer'

export interface SpeqConfig {
  version: number
  plugins: string[]
  /** Per-plugin blocks, keyed by short name: `http`, `postgres`, … */
  settings: Record<string, unknown>
  /** Every file that contributed, nearest last. For diagnostics. */
  sources: string[]
}

interface RawConfig {
  version?: number
  extends?: string | string[]
  plugins?: unknown
  [key: string]: unknown
}

const RESERVED = new Set(['version', 'extends', 'plugins'])

/**
 * Reads speq.yaml and flattens its `extends` chain.
 *
 * `extends` is what keeps thirty microservices from drifting into thirty
 * different plugin sets: the platform team publishes one preset package and
 * bumps it in one place. It has to exist from the start — retrofitting it onto
 * a flat config later means rewriting every project's file.
 */
export function loadConfig(root: string): SpeqConfig {
  const file = join(root, 'speq.yaml')
  if (!existsSync(file)) {
    throw new Error(`no speq.yaml in ${root}; run 'speq init'`)
  }

  const merged: SpeqConfig = { version: 1, plugins: [], settings: {}, sources: [] }
  const seen = new Set<string>()
  applyFile(file, merged, seen, root)

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

  const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as RawConfig
  const presets = raw.extends ? (Array.isArray(raw.extends) ? raw.extends : [raw.extends]) : []
  return { extends: presets.filter((p) => typeof p === 'string'), plugins: normalisePlugins(raw.plugins, file) }
}

function applyFile(file: string, out: SpeqConfig, seen: Set<string>, root: string): void {
  const key = resolve(file)
  if (seen.has(key)) {
    throw new Error(`circular 'extends' involving ${file}`)
  }
  seen.add(key)

  let raw: RawConfig
  try {
    raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as RawConfig
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Presets first, so the local file wins on conflicts.
  const parents = raw.extends ? (Array.isArray(raw.extends) ? raw.extends : [raw.extends]) : []
  for (const parent of parents) {
    applyFile(resolvePreset(parent, dirname(file), root), out, seen, root)
  }

  if (typeof raw.version === 'number') out.version = raw.version
  for (const name of normalisePlugins(raw.plugins, file)) {
    if (!out.plugins.includes(name)) out.plugins.push(name)
  }
  for (const [k, v] of Object.entries(raw)) {
    if (RESERVED.has(k)) continue
    out.settings[k] = isPlainObject(v) && isPlainObject(out.settings[k])
      ? { ...(out.settings[k] as object), ...v }
      : v
  }
  out.sources.push(file)
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
