import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Plugins that come from a repository rather than from the registry.
 *
 *   github:acme/speqkit-plugin-legacy            default branch
 *   github:acme/speqkit-plugin-legacy#v2.1.0     tag, branch or commit
 *   gitlab:team/plugin#main
 *   bitbucket:team/plugin#8f2c1ad
 *   git+https://git.acme.internal/qa/plugin.git#main
 *   git+ssh://git@github.com/acme/private-plugin.git#v1
 *
 * This shells out to `git`, and that is a deliberate exception to the rule
 * that governs everything else here. `speq install` speaks the npm registry's
 * HTTP API itself because npm is the tool being replaced — requiring it would
 * cancel the whole idea. Git is not being replaced by anything, it is already
 * on the machine of anyone whose repository this is, and going through it buys
 * three things no amount of hand-written HTTP would: private repositories work
 * through the credentials and ssh agent the user already has, self-hosted
 * hosts work with no per-vendor API dialect, and the commit is verified by git
 * rather than trusted from a vendor's JSON.
 *
 * A ref is resolved to a commit at install time and only the commit is
 * written to the lock, so `--frozen` in CI replays a tag that has since moved.
 */
export interface GitSource {
  /** Exactly what speq.yaml said. */
  raw: string
  /** What git is asked to fetch from. */
  url: string
  /** Tag, branch or commit as written; absent means the default branch. */
  ref?: string
}

const HOSTS: Record<string, string> = {
  github: 'https://github.com/',
  gitlab: 'https://gitlab.com/',
  bitbucket: 'https://bitbucket.org/'
}

const SHA = /^[0-9a-f]{40}$/i

export function parseGitSpec(raw: string): GitSource | undefined {
  const trimmed = raw.trim()
  const [locator, ref] = split(trimmed)

  const shorthand = /^(github|gitlab|bitbucket):(.+)$/i.exec(locator)
  if (shorthand) {
    const [, host, path] = shorthand
    if (!/^[^/]+\/[^/]+$/.test(path!)) {
      throw new Error(`'${raw}' is not a ${host} spec; it should look like ${host!.toLowerCase()}:owner/repo#ref`)
    }
    return { raw: trimmed, url: `${HOSTS[host!.toLowerCase()]}${path!.replace(/\.git$/, '')}.git`, ref }
  }

  // `git+https://…` is npm's spelling and the one people paste. The `git+`
  // exists to tell a URL that happens to be reachable over HTTP apart from a
  // tarball at the same address, which is a distinction we need too.
  // `file` is here for the same reason a bare repository on a shared drive is
  // a legitimate remote: git treats it as one, and so does everything below.
  const url = /^git\+(https?|ssh|file):\/\/(.+)$/i.exec(locator)
  if (url) return { raw: trimmed, url: `${url[1]}://${url[2]}`, ref }
  if (/^git:\/\//i.test(locator)) return { raw: trimmed, url: locator, ref }

  return undefined
}

/** A `#ref` suffix, without mistaking a fragment inside a query for one. */
function split(spec: string): [string, string | undefined] {
  const hash = spec.indexOf('#')
  return hash < 0 ? [spec, undefined] : [spec.slice(0, hash), spec.slice(hash + 1) || undefined]
}

export function isGitSpec(spec: string): boolean {
  return /^(github|gitlab|bitbucket|git\+https?|git\+ssh|git\+file|git):/i.test(spec.trim())
}

/**
 * The one place git is required, and the message says so — a user who never
 * writes a git spec must never be told to install anything.
 */
function git(args: string[], options: { cwd?: string } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Fails instead of stopping the run to ask for a password nobody is
      // there to type. In CI the alternative is a job that hangs until the
      // six-hour timeout.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }).trim()
  } catch (err) {
    const detail = err as { code?: string; stderr?: string; message?: string }
    if (detail.code === 'ENOENT') {
      throw new Error(
        `a git spec needs git on PATH, and there is none.\n` +
          `  Only specs naming a repository need it; the registry is reached over HTTP directly.`
      )
    }
    throw new Error(`git ${args[0]} failed: ${(detail.stderr || detail.message || '').trim().split('\n')[0]}`)
  }
}

/**
 * A ref to the commit it points at right now.
 *
 * Done separately from fetching, and before it, because this is what the lock
 * records. `#main` in speq.yaml resolves to a different commit next month;
 * `--frozen` has to install the one that was reviewed.
 */
export function resolveCommit(source: GitSource): string {
  if (source.ref && SHA.test(source.ref)) return source.ref.toLowerCase()

  const ref = source.ref
  const output = ref ? git(['ls-remote', source.url, ref, `refs/tags/${ref}`, `refs/heads/${ref}`]) : git(['ls-remote', source.url, 'HEAD'])

  const lines = output.split('\n').filter(Boolean)
  if (lines.length === 0) {
    throw new Error(
      ref
        ? `'${ref}' is not a branch, tag or commit in ${source.url}`
        : `${source.url} has no HEAD; is it an empty repository?`
    )
  }
  // An annotated tag resolves twice, as `refs/tags/x` and `refs/tags/x^{}`.
  // The dereferenced one is the commit; the other is the tag object, which is
  // not what anybody means by "install this tag".
  const dereferenced = lines.find((l) => l.endsWith('^{}'))
  return (dereferenced ?? lines[0]!).split('\t')[0]!.toLowerCase()
}

/**
 * The repository at that commit, on disk, cached by commit.
 *
 * Cached under the commit rather than the ref for the reason the whole
 * installer exists: two projects asking for `#main` on different days must not
 * silently share one checkout.
 */
export function fetchCommit(source: GitSource, commit: string, cacheRoot: string): string {
  const target = join(cacheRoot, commit)
  if (existsSync(join(target, 'package.json'))) return target

  const staging = `${target}.tmp-${process.pid}-${Date.now()}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  try {
    git(['init', '--quiet'], { cwd: staging })
    git(['remote', 'add', 'origin', source.url], { cwd: staging })
    try {
      // One commit and no history. Most hosts allow asking for a bare sha;
      // the ones that do not get the slow path rather than an error.
      git(['fetch', '--quiet', '--depth', '1', 'origin', commit], { cwd: staging })
    } catch {
      git(['fetch', '--quiet', 'origin'], { cwd: staging })
    }
    git(['checkout', '--quiet', commit], { cwd: staging })
    // The history is not the package, and leaving it behind would put a
    // repository inside the store for every plugin installed this way.
    rmSync(join(staging, '.git'), { recursive: true, force: true })

    if (!existsSync(join(staging, 'package.json'))) {
      throw new Error(`${source.url} at ${commit.slice(0, 8)} has no package.json; it is not an npm package`)
    }

    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    return target
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export interface GitManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  main?: string
  exports?: unknown
}

export function readManifest(dir: string, source: GitSource): GitManifest {
  let manifest: GitManifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as GitManifest
  } catch (err) {
    throw new Error(`${source.url}: package.json is not readable JSON (${err instanceof Error ? err.message : err})`)
  }
  if (!manifest.name || !manifest.version) {
    throw new Error(`${source.url}: package.json needs both a name and a version`)
  }
  return manifest
}

/**
 * The version a git checkout is stored under.
 *
 * The commit goes in as semver build metadata, because two commits can carry
 * the same `version` field and the store is keyed by name and version. Build
 * metadata is ignored by range matching, which is the correct behaviour here:
 * a dependency asking for `^1.2.0` is satisfied by this package whatever
 * commit it came from.
 */
export function gitVersion(version: string, commit: string): string {
  return `${version.split('+')[0]}+${commit.slice(0, 12)}`
}

/**
 * Nothing here runs a build. A repository whose entry point is not committed
 * would install cleanly and then fail to load, several minutes later, inside
 * a plugin loader that cannot say why.
 *
 * Not running install scripts is the security property that makes installing
 * from a repository defensible at all — so this reports the consequence
 * rather than removing it.
 */
export function assertBuilt(dir: string, manifest: GitManifest, source: GitSource): void {
  const entry = entryOf(manifest) ?? 'index.js'
  if (existsSync(join(dir, entry))) return

  throw new Error(
    `${source.raw} resolves to ${manifest.name}@${manifest.version}, whose entry point '${entry}' is not in the repository.\n` +
      `  speq does not run build or prepare scripts, on purpose: installing from a repository must not execute it.\n` +
      `  The repository needs its build output committed, or the plugin needs publishing to a registry.\n` +
      `  Present at the top level: ${readdirSync(dir).slice(0, 12).join(', ')}`
  )
}

function entryOf(manifest: GitManifest): string | undefined {
  const exports = manifest.exports
  if (typeof exports === 'string') return exports
  if (exports && typeof exports === 'object') {
    const dot = (exports as Record<string, unknown>)['.'] ?? exports
    if (typeof dot === 'string') return dot
    if (dot && typeof dot === 'object') {
      for (const key of ['import', 'module', 'default', 'require']) {
        const value = (dot as Record<string, unknown>)[key]
        if (typeof value === 'string') return value
      }
    }
  }
  return manifest.main
}
