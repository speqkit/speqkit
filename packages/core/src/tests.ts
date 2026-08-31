import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import type { LoaderDef, SuiteDef, TestDef } from '@speqkit/plugin-api'
import type { Registered, Registry } from './registry.js'

export interface DiscoverOptions {
  root: string
  test?: string
  suite?: string
  tags?: string[]
  names?: string[]
}

type Loaders = Map<string, Registered<LoaderDef>>

/**
 * Discovery asks the loaders, not the filesystem, what a test file is.
 * The authoring format is itself a plugin point: YAML is the default, and a
 * TypeScript loader is an ordinary plugin rather than a fork of the kernel.
 *
 * Three things happen here that the loaders deliberately do not do, because
 * each of them has to be true for every format at once: a test learns which
 * suites it is inside and inherits what they declare, a `cases` table becomes
 * that many tests, and the result is narrowed to what was asked for.
 */
export async function discoverTests(registry: Registry, options: DiscoverOptions): Promise<TestDef[]> {
  const byExtension: Loaders = new Map()
  for (const [, entry] of registry.loaders) {
    for (const ext of entry.def.extensions) byExtension.set(ext, entry)
  }
  if (byExtension.size === 0) {
    throw new Error(
      "no loader is registered, so no test file can be read. Add a loader plugin (for YAML: '@speqkit/plugin-yaml')."
    )
  }

  const base = options.suite ? join(options.root, options.suite) : join(options.root, 'suites')
  const files = options.test
    ? [join(options.root, options.test)]
    : walk(base).filter((f) => byExtension.has(extname(f)))

  const suites = new SuiteReader(byExtension, options.root)
  const tests: TestDef[] = []

  for (const file of files.sort()) {
    const entry = byExtension.get(extname(file))
    if (!entry || isManifest(entry.def, file)) continue
    const loaded = await entry.def.load(file, readFileSync(file, 'utf8'))
    const chain = await suites.chainFor(dirname(file))
    for (const test of loaded) {
      const placed: TestDef = {
        ...test,
        source: relative(options.root, file),
        ...(chain.length > 0 ? { suites: chain } : {})
      }
      tests.push(...expand(inherit(placed, chain)))
    }
  }

  return narrow(tests, options)
}

/**
 * What the suites above a test declare, folded into the test itself.
 *
 * Outside-in, nearest wins, and the test wins over all of them: `meta` merged
 * key by key, `tags` unioned because a label added by a directory and a label
 * added by the test are two labels, and `pending` taken from the nearest
 * suite that parks itself.
 *
 * Folded in here rather than read at the point of use, so that everything
 * downstream — validation, the run, the report, an agent reading
 * `events.jsonl` — sees one test with one set of annotations, and nothing has
 * to know that inheritance exists.
 */
function inherit(test: TestDef, chain: readonly SuiteDef[]): TestDef {
  if (chain.length === 0) return test

  const meta: Record<string, unknown> = {}
  const tags = new Set<string>()
  let pending: string | undefined
  for (const suite of chain) {
    Object.assign(meta, suite.meta ?? {})
    for (const tag of suite.tags ?? []) tags.add(tag)
    if (suite.pending) pending = suite.pending
  }
  Object.assign(meta, test.meta ?? {})
  for (const tag of test.tags ?? []) tags.add(tag)

  const inheritedPending = test.pending ?? pending
  return {
    ...test,
    ...(tags.size > 0 ? { tags: [...tags] } : {}),
    ...(inheritedPending !== undefined ? { pending: inheritedPending } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  }
}

/**
 * A `cases` table becomes that many tests, here and not in the loader.
 *
 * Before validation and before anything counts tests, so a case is an
 * ordinary test everywhere it matters — five rows in the report, five names
 * `speq validate` checks, one of them re-runnable on its own.
 *
 * A malformed table is left exactly as written rather than half-expanded.
 * `validateTests` is what reports it, and it cannot report a table that has
 * already been turned into tests.
 */
function expand(test: TestDef): TestDef[] {
  const table = test.cases
  if (!Array.isArray(table) || table.length === 0 || !wellFormed(table)) return [test]

  const { cases: _table, ...base } = test
  return table.map((entry) => {
    const title = entry.title ?? base.title
    const pending = entry.pending ?? base.pending
    const tags = [...new Set([...(base.tags ?? []), ...(entry.tags ?? [])])]
    const meta = { ...base.meta, ...entry.meta }
    return {
      ...base,
      name: `${test.name}[${entry.id}]`,
      group: test.name,
      ...(title !== undefined ? { title } : {}),
      ...(pending !== undefined ? { pending } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(base.variables ?? entry.variables
        ? { variables: { ...base.variables, ...entry.variables } }
        : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    }
  })
}

function wellFormed(table: unknown[]): boolean {
  const ids = new Set<string>()
  for (const entry of table) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) return false
    ids.add(id)
  }
  return true
}

function narrow(tests: TestDef[], options: DiscoverOptions): TestDef[] {
  let out = tests
  if (options.names?.length) {
    const wanted = new Set(options.names)
    out = out.filter((t) => wanted.has(t.name))
  }
  if (options.tags?.length) {
    const wanted = new Set(options.tags)
    out = out.filter((t) => t.tags?.some((tag) => wanted.has(tag)))
  }
  return out
}

/**
 * Reads the manifests that turn directories into suites, once each.
 *
 * From disk rather than from what the walk happened to visit: `--test` naming
 * one file must see the same chain a full run gives it, or a test would mean
 * something different depending on how it was started.
 *
 * The cache lives for one discovery and no longer. A long-lived host — an
 * editor — is exactly where a cache goes stale on the file being edited.
 */
class SuiteReader {
  readonly #loaders: Loaders
  readonly #root: string
  readonly #known = new Map<string, SuiteDef | null>()

  constructor(loaders: Loaders, root: string) {
    this.#loaders = loaders
    this.#root = root
  }

  /** The declaring suites above a directory, outermost first. */
  async chainFor(dir: string): Promise<SuiteDef[]> {
    const out: SuiteDef[] = []
    for (const step of ancestry(dir, this.#root)) {
      const suite = await this.#read(step)
      if (suite) out.push(suite)
    }
    return out
  }

  async #read(dir: string): Promise<SuiteDef | null> {
    const cached = this.#known.get(dir)
    if (cached !== undefined) return cached

    let found: SuiteDef | null = null
    outer: for (const [, entry] of this.#loaders) {
      if (!entry.def.loadSuite) continue
      for (const name of entry.def.suiteFiles ?? []) {
        for (const ext of entry.def.extensions) {
          const file = join(dir, `${name}${ext}`)
          if (!existsSync(file)) continue
          const declared = await entry.def.loadSuite(file, readFileSync(file, 'utf8'))
          found = {
            ...declared,
            name: relative(this.#root, dir) || '.',
            source: relative(this.#root, file)
          }
          break outer
        }
      }
    }

    this.#known.set(dir, found)
    return found
  }
}

function isManifest(def: LoaderDef, file: string): boolean {
  return (def.suiteFiles ?? []).includes(basename(file, extname(file)))
}

/** Root first, the directory itself last — so the nearest declaration wins. */
function ancestry(dir: string, root: string): string[] {
  const inside = relative(root, dir)
  if (inside.startsWith('..')) return [dir]

  const out = [root]
  let walked = root
  for (const part of inside.split(sep).filter(Boolean)) {
    walked = join(walked, part)
    out.push(walked)
  }
  return out
}

function walk(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
