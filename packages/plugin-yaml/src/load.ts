import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { parseAllDocuments, parse as parseYaml } from 'yaml'
import type { TestDef } from '@speqkit/plugin-api'

/**
 * The keys the model owns. Everything else a test writes is an annotation.
 *
 * Closing this list is what makes `epic: menu` work without declaring
 * anything: a key is either part of the spine — and then it means something to
 * the kernel — or it is not, and then it is carried and never read. There is
 * deliberately no third category and no way to register one, because a
 * contribution point for annotations is a contract we would owe forever in
 * exchange for labels in a report.
 */
const SPINE = new Set([
  'id', 'title', 'name', 'tags', 'variables', 'setup', 'steps', 'assert', 'cleanup', 'meta'
])

/** A file by this name describes the directory it is in, and is never a test. */
const DIRECTORY_FILE = 'init'

export interface LoadOptions {
  /** The project root, so the `init.yaml` chain stops somewhere sensible. */
  root: string
}

export function loadTests(file: string, content: string, options: LoadOptions): TestDef[] {
  if (basename(file, extname(file)) === DIRECTORY_FILE) return []

  const inherited = inheritedMeta(dirname(file), options.root)
  const tests: TestDef[] = []

  for (const doc of parseAllDocuments(content)) {
    if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]!.message}`)
    const value = doc.toJS() as Record<string, unknown> | null
    if (!value) continue

    const meta = { ...inherited, ...annotations(value) }
    const name = str(value.id) ?? str(value.name) ?? basename(file, extname(file))

    tests.push({
      name,
      ...(str(value.title) ? { title: str(value.title)! } : {}),
      tags: (value.tags as string[] | undefined) ?? [],
      ...(value.variables ? { variables: value.variables as Record<string, unknown> } : {}),
      ...(value.setup ? { setup: value.setup as TestDef['setup'] } : {}),
      steps: (value.steps as TestDef['steps']) ?? [],
      assert: (value.assert as TestDef['assert']) ?? [],
      ...(value.cleanup ? { cleanup: value.cleanup as TestDef['cleanup'] } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    })
  }
  return tests
}

/** Bare keys outside the spine, plus whatever an explicit `meta:` block adds. */
function annotations(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!SPINE.has(key)) out[key] = entry
  }
  const declared = value.meta
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    Object.assign(out, declared as Record<string, unknown>)
  }
  return out
}

/**
 * Annotations a directory hands to every test under it.
 *
 * `epic: menu` belongs on the directory that *is* the menu group, written
 * once, rather than copied into twelve files where the thirteenth will be
 * forgotten. Nearest wins, so a subdirectory sharpens what it inherited and a
 * test overrides both.
 *
 * Read from disk rather than from what discovery happens to have walked: a
 * `--test` naming one file must see the same annotations that file gets in a
 * full run, or a report would depend on how the run was started.
 *
 * Deliberately not memoised. The chain is four `existsSync` calls per test
 * file, and the alternative is a cache that goes stale under the one host
 * that would benefit from it — an editor, where the file being edited is
 * exactly the one whose answer is wrong.
 */
function inheritedMeta(dir: string, root: string): Record<string, unknown> {
  const chain = ancestry(dir, root)
  const meta: Record<string, unknown> = {}
  for (const step of chain) {
    for (const ext of ['.yaml', '.yml']) {
      const file = join(step, `${DIRECTORY_FILE}${ext}`)
      if (!existsSync(file)) continue
      const value = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>
      Object.assign(meta, annotations(value))
    }
  }

  return meta
}

/** Root first, the test's own directory last — so the nearest file wins. */
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
