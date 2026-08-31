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
async function packument(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' }
  })
  if (res.status === 404) return { versions: {} }
  if (!res.ok) throw new Error(`${REGISTRY}/${name} answered ${res.status} ${res.statusText}`)
  return await res.json()
}

/**
 * Does `version` satisfy `range`?
 *
 * Deliberately not semver-complete: this script runs before `pnpm install`,
 * so it has no dependencies, and the only ranges we ever publish are the
 * `^x.y.z` that pnpm writes when it expands `workspace:^`. Anything else is
 * reported as unknown rather than guessed at — a wrong "fine" here is worse
 * than no answer, because it is an answer somebody would act on.
 */
function satisfiesCaret(version, range) {
  if (!range || range === '*' || range === 'x') return true
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim())
  if (!m) return null
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!v) return null
  const [rMaj, rMin, rPat] = m.slice(1).map(Number)
  const [maj, min, pat] = v.slice(1).map(Number)

  // A caret on 0.x pins the minor, which is the whole reason this matters:
  // ^0.4.0 does not accept 0.9.0, and the contract has been 0.x all along.
  const upper = rMaj === 0 ? [0, rMin + 1, 0] : [rMaj + 1, 0, 0]
  const ge = maj > rMaj || (maj === rMaj && (min > rMin || (min === rMin && pat >= rPat)))
  const lt = maj < upper[0] || (maj === upper[0] && (min < upper[1] || (min === upper[1] && pat < upper[2])))
  return ge && lt
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

const CONTRACT = '@speqkit/plugin-api'

const packages = workspacePackages()
const core = packages.find((p) => p.name === 'speqkit')
if (!core) {
  console.error('packages/core is not in the workspace; there is nothing to version a release by.')
  process.exit(1)
}

const results = await Promise.all(
  packages.map(async (pkg) => {
    const doc = await packument(pkg.name)
    const versions = doc.versions ?? {}
    const latest = doc['dist-tags']?.latest
    return {
      ...pkg,
      published: Object.keys(versions),
      // What the newest published copy asks of the contract. Read from the
      // registry rather than from disk, because on disk every plugin says
      // `workspace:^` and is therefore always, uselessly, up to date.
      publishedPeer: latest ? versions[latest]?.peerDependencies?.[CONTRACT] : undefined
    }
  })
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

/**
 * Plugins whose *published* copy asks for a contract the current one no longer
 * satisfies. They are not broken — `PLUGIN_API_VERSION` is what decides
 * loadability, and it is still 1 — but a fresh `speq install` downloads a
 * second, older copy of the contract to satisfy the stale range, which is
 * confusing in a log and pointless on disk.
 *
 * This is here because it was found the expensive way: by reading an install
 * log after a release and noticing plugin-api arrive twice. A plugin whose
 * version does not move is correctly skipped by the publish — and quietly
 * keeps whatever range it was published with. Bumping it is the fix, and the
 * only hard part was knowing.
 */
const contractVersion = packages.find((p) => p.name === CONTRACT)?.version
plan.staleContract = contractVersion
  ? results
      .filter((p) => {
        if (!p.publishedPeer) return false
        // Already going out in this run — it will be republished against the
        // current contract, so there is nothing to report.
        if (!p.published.includes(p.version)) return false
        return satisfiesCaret(contractVersion, p.publishedPeer) === false
      })
      .map((p) => `${p.name}@${p.version} asks for ${p.publishedPeer}`)
  : []

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
  if (plan.staleContract.length > 0) {
    console.log()
    console.log(`  \x1b[33mpublished against an older contract\x1b[0m (${CONTRACT} is now ${contractVersion})`)
    for (const line of plan.staleContract) console.log(`    ${line}`)
    console.log(dim('    Not broken — but each one makes an install fetch a second copy of'))
    console.log(dim('    the contract. Bump the version to have it republished.'))
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
