import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type LayoutMode = 'in-repo' | 'test-repo' | 'explicit'

export interface SpeqRoot {
  root: string
  mode: LayoutMode
}

const CONFIG = 'speq.yaml'
const SUITES = 'suites'

/**
 * Finds the project root by walking up, the way git and cargo do. The nearest
 * root wins, so a project nested inside another works on its own.
 *
 * `in-repo` — `.speq/` inside the service's repository. The default: tests
 * live next to the code they check.
 * `test-repo` — the repository is nothing but tests. Where cross-service
 * end-to-end suites belong, since they own no single service.
 */
export function discoverRoot(explicit?: string, from = process.cwd()): SpeqRoot {
  if (explicit) {
    return { root: isAbsolute(explicit) ? explicit : resolve(from, explicit), mode: 'explicit' }
  }

  let dir = resolve(from)
  for (;;) {
    const inRepo = looksLikeProject(join(dir, '.speq'))
    const testRepo = looksLikeProject(dir)

    if (inRepo && testRepo) {
      throw new Error(
        `ambiguous speq layout in ${dir}: both .speq and the directory itself look valid, pass --speq-root`
      )
    }
    if (inRepo) return { root: join(dir, '.speq'), mode: 'in-repo' }
    if (testRepo) return { root: dir, mode: 'test-repo' }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new Error(
    `speq root not found in ${from} or any parent directory; run 'speq init' or pass --speq-root`
  )
}

function looksLikeProject(dir: string): boolean {
  return existsSync(join(dir, CONFIG)) && isDir(join(dir, SUITES))
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
