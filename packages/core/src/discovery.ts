import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { StartupError } from './errors.js'

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
      throw new StartupError(
        'ambiguous-root',
        `ambiguous speq layout in ${dir}: both .speq and the directory itself look valid, pass --speq-root`
      )
    }
    if (inRepo) return { root: join(dir, '.speq'), mode: 'in-repo' }
    if (testRepo) return { root: dir, mode: 'test-repo' }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const v1 = looksLikeVersionOne(from) ?? looksLikeVersionOne(join(from, '.speq'))
  if (v1) {
    throw new StartupError(
      'v1-project',
      `${v1} is a speq 1.x project: it has manifest.yaml where this build expects speq.yaml. ` +
        `Run 'speq init' beside it and then 'speq migrate --from ${v1}'.`
    )
  }

  throw new StartupError(
    'no-root',
    `speq root not found in ${from} or any parent directory; run 'speq init' or pass --speq-root`
  )
}

/**
 * Named, not adopted. Booting inside a v1 project would mean every command
 * failing later and further from the cause; saying so here costs one branch
 * and turns a dead end into the next command to type.
 */
function looksLikeVersionOne(dir: string): string | undefined {
  return existsSync(join(dir, 'manifest.yaml')) && isDir(join(dir, SUITES)) ? dir : undefined
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
