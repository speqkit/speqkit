import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * The repository's own wiring, checked the way plugin manifests are.
 *
 * These are not tests of the kernel; they are tests of the arrangement that
 * lets the kernel be tested at all. They live here because the failure they
 * catch is invisible on a machine that has built once — which is every
 * machine a person works on, and none of the machines a release runs on.
 */

function workspacePackages(): { dir: string; name: string }[] {
  const packages = join(repo, 'packages')
  return readdirSync(packages)
    .map((dir) => ({ dir, manifest: join(packages, dir, 'package.json') }))
    .filter(({ manifest }) => {
      try {
        return !JSON.parse(readFileSync(manifest, 'utf8')).private
      } catch {
        return false
      }
    })
    .map(({ dir, manifest }) => ({ dir, name: JSON.parse(readFileSync(manifest, 'utf8')).name as string }))
}

describe('typechecking does not require a build', () => {
  it('maps every workspace package to its source in tsconfig.json', () => {
    // The file has comments, which is legal in a tsconfig and not in JSON.
    const raw = readFileSync(join(repo, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const paths = JSON.parse(raw).compilerOptions.paths as Record<string, string[]>

    const missing = workspacePackages().filter(({ name }) => !paths[name])

    // Without an entry, TypeScript resolves the package through `exports` —
    // which names `dist/index.d.ts`. `pnpm typecheck` then passes for anyone
    // who has run `pnpm build` and fails on a clean clone, which is to say it
    // passes for the author and fails in CI. Three packages had gone missing
    // this way before anyone noticed, and only because two new tests happened
    // to import them.
    expect(
      missing.map((p) => p.name),
      'add these to compilerOptions.paths in tsconfig.json, pointing at packages/<dir>/src/index.ts'
    ).toEqual([])
  })

  it('points each of them at a file that is there', () => {
    const raw = readFileSync(join(repo, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const paths = JSON.parse(raw).compilerOptions.paths as Record<string, string[]>

    for (const [name, [target]] of Object.entries(paths)) {
      expect(target, `${name} has no target`).toBeDefined()
      expect(() => readFileSync(join(repo, target as string), 'utf8'), `${name} -> ${target}`).not.toThrow()
    }
  })
})
