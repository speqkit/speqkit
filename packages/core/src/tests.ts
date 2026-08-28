import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { TestDef } from '@speq/plugin-api'
import type { Registry } from './registry.js'

export interface DiscoverOptions {
  root: string
  test?: string
  suite?: string
  tags?: string[]
}

/**
 * Discovery asks the loaders, not the filesystem, what a test file is.
 * The authoring format is itself a plugin point: YAML is the default, and a
 * TypeScript loader is an ordinary plugin rather than a fork of the kernel.
 */
export async function discoverTests(registry: Registry, options: DiscoverOptions): Promise<TestDef[]> {
  const byExtension = new Map<string, (typeof registry.loaders extends Map<string, infer V> ? V : never)>()
  for (const [, entry] of registry.loaders) {
    for (const ext of entry.def.extensions) byExtension.set(ext, entry)
  }
  if (byExtension.size === 0) {
    throw new Error(
      "no loader is registered, so no test file can be read. Add a loader plugin (for YAML: '@speq/plugin-yaml')."
    )
  }

  const base = options.suite ? join(options.root, options.suite) : join(options.root, 'suites')
  const files = options.test
    ? [join(options.root, options.test)]
    : walk(base).filter((f) => byExtension.has(extname(f)))

  const tests: TestDef[] = []
  for (const file of files.sort()) {
    const entry = byExtension.get(extname(file))
    if (!entry) continue
    const loaded = await entry.def.load(file, readFileSync(file, 'utf8'))
    for (const test of loaded) {
      tests.push({ ...test, source: relative(options.root, file) })
    }
  }

  if (!options.tags?.length) return tests
  const wanted = new Set(options.tags)
  return tests.filter((t) => t.tags?.some((tag) => wanted.has(tag)))
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
