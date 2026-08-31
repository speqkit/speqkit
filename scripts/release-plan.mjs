#!/usr/bin/env node
/**
 * What, if anything, does this commit release?
 *
 *   node scripts/release-plan.mjs            # human-readable
 *   node scripts/release-plan.mjs --json     # the same, as JSON
 *   node scripts/release-plan.mjs --github-output   # append to $GITHUB_OUTPUT
 *
 * There is no changelog tool here and no commit-message convention, on
 * purpose. The version in a `package.json` *is* the intent: it arrives in a
 * diff, gets reviewed like anything else, and one person can see the whole
 * decision at once. Everything downstream is derived from it, so this script
 * never decides what the next version should be — it only reports which of
 * the versions already written down have not shipped yet.
 *
 * The two sources of truth are both outside the repository, which is what
 * makes the whole thing idempotent: the **npm registry** says which package
 * versions exist, and the **git tags on the remote** say which releases were
 * cut. Re-running a release job that already succeeded therefore finds
 * nothing to do rather than publishing a second time — and a job that failed
 * halfway can simply be re-run, because whatever got through the first time
 * is now indistinguishable from something published last month.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)

const REGISTRY = process.env.SPEQKIT_REGISTRY ?? 'https://registry.npmjs.org'

/* ------------------------------------------------------------------ */
/* The workspace                                                       */
/* ------------------------------------------------------------------ */

/**
 * Read straight from the directory rather than from pnpm, so this runs before
 * `pnpm install` has happened and cannot disagree with what the release job
 * actually publishes. `examples/*` is in the workspace too and is `private`,
 * which is exactly how it stays out of here.
 */
function workspacePackages() {
  const dir = join(repo, 'packages')
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const manifest = join(dir, name, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (pkg.private) continue
    out.push({ dir: name, name: pkg.name, version: pkg.version })
  }
  return out
}

/**
 * Every version the registry has for a name. A 404 means nobody has ever
 * published it, which is a normal answer and not an error — six of ours are
 * in that state right now.
 *
 * Anything else that is not a 200 throws. A registry that is briefly down
 * must not read as "nothing is published", because the caller would then
 * cheerfully try to publish fifteen packages that are already there.
 */
async function publishedVersions(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' }
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`${REGISTRY}/${name} answered ${res.status} ${res.statusText}`)
  const body = await res.json()
  return Object.keys(body.versions ?? {})
}

/**
 * Tags on the remote, not in the local checkout: a shallow CI clone has no
 * tags at all, and asking the remote is both cheaper and the thing that
 * actually decides whether `git push` would collide.
 */
function remoteTags() {
  try {
    const out = execFileSync('git', ['ls-remote', '--tags', 'origin'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return new Set(
      out
        .split('\n')
        .map((line) => line.split('\t')[1])
        .filter(Boolean)
        .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''))
    )
  } catch {
    // No remote (a bare checkout, someone's laptop). Report no tags rather
    // than failing: the caller is asking a question, and "none that I can
    // see" is a truthful answer that the workflow will re-ask with a remote.
    return new Set()
  }
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

const packages = workspacePackages()
const core = packages.find((p) => p.name === 'speqkit')
if (!core) {
  console.error('packages/core is not in the workspace; there is nothing to version a release by.')
  process.exit(1)
}

const results = await Promise.all(
  packages.map(async (pkg) => ({ ...pkg, published: await publishedVersions(pkg.name) }))
)

const toPublish = results.filter((p) => !p.published.includes(p.version))
const tag = `v${core.version}`
const tagExists = remoteTags().has(tag)

/**
 * The binary release rides on the kernel's version and nothing else. A plugin
 * bumping its patch number does not deserve four 100 MB executables and a new
 * Homebrew formula — the executable would be byte-identical apart from a
 * version string it does not carry. So: npm publishes whatever is missing,
 * and a tag is cut only when the kernel itself moved.
 */
const plan = {
  tag,
  coreVersion: core.version,
  publishNpm: toPublish.length > 0,
  cutRelease: !tagExists,
  npmPackages: toPublish.map((p) => `${p.name}@${p.version}`),
  skipped: results
    .filter((p) => p.published.includes(p.version))
    .map((p) => `${p.name}@${p.version}`)
}
plan.anything = plan.publishNpm || plan.cutRelease

/* ------------------------------------------------------------------ */
/* Say it                                                              */
/* ------------------------------------------------------------------ */

if (has('--json')) {
  console.log(JSON.stringify(plan, null, 2))
} else {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`
  console.log(`\nrelease plan for ${tag}\n`)
  if (plan.npmPackages.length > 0) {
    console.log('  publish to npm')
    for (const p of plan.npmPackages) console.log(`    ${p}`)
  } else {
    console.log(dim('  publish to npm: nothing — every version here is already in the registry'))
  }
  console.log()
  console.log(
    plan.cutRelease
      ? `  cut ${tag}: four executables, a GitHub release and the Homebrew formula`
      : dim(`  cut ${tag}: no — that tag is already on the remote`)
  )
  if (plan.skipped.length > 0) {
    console.log()
    console.log(dim(`  already published: ${plan.skipped.length} package(s)`))
  }
  console.log()
  if (!plan.anything) console.log(dim('  nothing to do. Bump a version in a package.json to release.\n'))
}

if (has('--github-output') && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `tag=${plan.tag}`,
      `core_version=${plan.coreVersion}`,
      `publish_npm=${plan.publishNpm}`,
      `cut_release=${plan.cutRelease}`,
      `anything=${plan.anything}`,
      `npm_packages=${plan.npmPackages.join(' ')}`
    ].join('\n') + '\n'
  )
}
