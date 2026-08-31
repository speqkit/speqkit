import { basename, extname } from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { SuiteDef, TestDef } from '@speqkit/plugin-api'

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
  'id', 'title', 'name', 'tags', 'pending', 'variables', 'cases', 'setup', 'steps', 'assert',
  'cleanup', 'meta'
])

/** The same list for a suite manifest, which declares no steps of its own body. */
const SUITE_SPINE = new Set(['title', 'tags', 'pending', 'setup', 'cleanup', 'meta'])

/**
 * A file by one of these names describes the directory it is in, and is never
 * a test. `suite` is the name; `init` is what the first release called it, and
 * is still read so that a project written against it does not silently start
 * running its manifest as an empty test.
 */
export const SUITE_FILES = ['suite', 'init']

export function loadTests(file: string, content: string): TestDef[] {
  if (SUITE_FILES.includes(basename(file, extname(file)))) return []

  const tests: TestDef[] = []

  for (const doc of parseAllDocuments(content)) {
    if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]!.message}`)
    const value = doc.toJS() as Record<string, unknown> | null
    if (!value) continue

    const meta = annotations(value, SPINE)
    const name = str(value.id) ?? str(value.name) ?? basename(file, extname(file))

    tests.push({
      name,
      ...(str(value.title) ? { title: str(value.title)! } : {}),
      ...(value.pending !== undefined ? { pending: value.pending as string } : {}),
      tags: (value.tags as string[] | undefined) ?? [],
      ...(value.variables ? { variables: value.variables as Record<string, unknown> } : {}),
      ...(value.cases ? { cases: value.cases as TestDef['cases'] } : {}),
      ...(value.setup ? { setup: value.setup as TestDef['setup'] } : {}),
      steps: (value.steps as TestDef['steps']) ?? [],
      assert: (value.assert as TestDef['assert']) ?? [],
      ...(value.cleanup ? { cleanup: value.cleanup as TestDef['cleanup'] } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    })
  }
  return tests
}

/**
 * What a directory declares about every test beneath it.
 *
 * The kernel decides what a suite means — the tree, the identity, which parts
 * are inherited and when its setup runs. This reads the fields out of YAML and
 * stops there, which is exactly the split that lets a TypeScript loader
 * declare suites without reimplementing any of it.
 */
export function loadSuite(file: string, content: string): SuiteDef {
  const value = (parseAllDocuments(content)[0]?.toJS() ?? {}) as Record<string, unknown>
  const meta = annotations(value, SUITE_SPINE)
  return {
    // Filled in by the kernel from the directory. A manifest that names itself
    // can name the directory next to it, and then two suites are one.
    name: '',
    ...(str(value.title) ? { title: str(value.title)! } : {}),
    ...(value.pending !== undefined ? { pending: value.pending as string } : {}),
    ...(value.tags ? { tags: value.tags as string[] } : {}),
    ...(value.setup ? { setup: value.setup as SuiteDef['setup'] } : {}),
    ...(value.cleanup ? { cleanup: value.cleanup as SuiteDef['cleanup'] } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  }
}

/** Bare keys outside the spine, plus whatever an explicit `meta:` block adds. */
function annotations(value: Record<string, unknown>, spine: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!spine.has(key)) out[key] = entry
  }
  const declared = value.meta
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    Object.assign(out, declared as Record<string, unknown>)
  }
  return out
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
