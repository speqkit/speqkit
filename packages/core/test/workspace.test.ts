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

describe('the ledger says what is there', () => {
  /** One row of `docs/architecture/plugins.html`: the package, and its chip. */
  function ledgerRows(): { name: string; written: boolean }[] {
    const page = readFileSync(join(repo, 'docs/architecture/plugins.html'), 'utf8')
    const ledger = /<section id="ledger">([\s\S]*?)<\/section>/.exec(page)?.[1] ?? ''
    return [...ledger.matchAll(/<tr><td>([^<]+)<\/td>[\s\S]*?<span class="chip ([a-z]+)">([^<]*)<\/span>/g)]
      .map((row) => ({ name: short(row[1]!.trim()), written: row[3]!.trim().startsWith('written') }))
  }

  /** `@speqkit/plugin-api` and `plugin-api` are the same package on that page. */
  const short = (name: string) => name.replace(/^@speqkit\//, '')

  it('names every package this repository publishes', () => {
    const listed = new Set(ledgerRows().map((r) => r.name))
    const missing = workspacePackages().map((p) => short(p.name)).filter((name) => !listed.has(name))

    // The ledger is the page a stranger reads to find out what exists. It had
    // drifted twice over: the contract's version was four minors stale, and
    // the count said five of nine were published when all nine were. A page
    // that is wrong about what we ship is worse than no page, because it is
    // the one thing nobody thinks to check.
    expect(missing, 'add a row to the ledger in docs/architecture/plugins.html').toEqual([])
  })

  it('does not call a package written when it is not here', () => {
    const here = new Set(workspacePackages().map((p) => short(p.name)))
    const claimed = ledgerRows().filter((r) => r.written && !here.has(r.name)).map((r) => r.name)

    expect(claimed, 'these are marked written and have no package').toEqual([])
  })
})

describe('a release says what changed', () => {
  it('names the version being released in CHANGELOG.md', () => {
    const version = JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')).version as string
    const headings = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8').match(/^##+ .*$/gm) ?? []

    // The kernel's version is what names a release: when it moves, four
    // executables, a tag and the Homebrew formula follow it, automatically and
    // with nobody in the loop. The one thing that arrangement cannot generate
    // is the sentence saying what changed — so the gate asks for it before the
    // release exists, rather than a human remembering afterwards.
    expect(
      headings.some((h) => h.includes(version)),
      `add a "## [${version}] — <date>" section to CHANGELOG.md; merging this bump publishes it`
    ).toBe(true)
  })
})
