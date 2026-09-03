#!/usr/bin/env node
/**
 * Is this directory a speq plugin that will actually work once published?
 *
 *   node check-plugin-package.mjs [dir]        # default: the current one
 *   node check-plugin-package.mjs --json
 *   node check-plugin-package.mjs --offline    # skip the registry question
 *
 * Written for plugin authors who are not us. Nothing here is speqkit-internal:
 * point it at any directory holding a plugin's `package.json` and it answers
 * the handful of questions whose wrong answer is invisible until a stranger
 * runs `speq install`.
 *
 * Every check below is a bug this project actually shipped, or one it caught
 * one commit before shipping:
 *
 *   - `exports` pointing at `.ts`. Everything green locally, because the tests
 *     resolve `src` through a bundler alias — and nothing loadable at all once
 *     installed, because Node refuses to strip types inside node_modules.
 *   - `dist` built but not in `files`. npm packs the manifest, not the
 *     directory, so the tarball is a README and a promise.
 *   - the kernel in `dependencies`. The installer will faithfully put a second
 *     copy of speqkit in the store and the plugin will faithfully boot it,
 *     and the compatibility check will then compare a contract against itself.
 *   - no `speqkit-plugin` keyword. The plugin works and nobody finds it.
 *   - no `docs`. The plugin loads, and `speq docs <name>` has nothing to say
 *     about it, so the first thing anybody who installs it does is read source.
 *
 * Exit codes: 0 all clear, 1 something is wrong, 2 there is nothing to check.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const dir = resolve(argv.find((a) => !a.startsWith('-')) ?? '.')
const REGISTRY = process.env.SPEQKIT_REGISTRY ?? 'https://registry.npmjs.org'

const manifestPath = join(dir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`no package.json in ${dir}`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

/* ------------------------------------------------------------------ */

const problems = []
const notes = []
const passed = []

const fail = (what, why) => problems.push({ what, why })
const warn = (what, why) => notes.push({ what, why })
const good = (what) => passed.push(what)

/** Does `file` fall under one of the `files` globs npm was given? */
function packed(file) {
  const files = pkg.files
  // No `files` at all means npm packs nearly everything, so anything on disk
  // ships. Wasteful, not broken.
  if (!Array.isArray(files)) return true
  const norm = file.replace(/^\.\//, '')
  return files.some((entry) => {
    const e = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return norm === e || norm.startsWith(`${e}/`)
  })
}

/** Every path an `exports` map can point a consumer at. */
function exportTargets(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) exportTargets(v, out)
  return out
}

/* ---- identity ----------------------------------------------------- */

if (pkg.private) fail('private', '`"private": true` — npm will refuse to publish this at all.')
else good('publishable')

if (!pkg.name) fail('name', 'the manifest has no name.')
if (!pkg.version) fail('version', 'the manifest has no version.')

// Ours are in that scope legitimately, and they say so in `repository`. The
// note is for everyone else, who would find out at `npm publish` time that
// the scope is not theirs.
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
if (String(pkg.name ?? '').startsWith('@speqkit/') && !repoUrl.includes('speqkit/speqkit')) {
  warn(
    'scope',
    'the `@speqkit` scope holds the plugins we maintain, and you will not be ' +
      'able to publish into it. Name it `speqkit-plugin-<name>` or ' +
      '`@your-scope/speqkit-plugin-<name>` — the kernel does not care about the ' +
      'name, and neither does the installer.'
  )
}

if (Array.isArray(pkg.keywords) && pkg.keywords.includes('speqkit-plugin')) good('keyword `speqkit-plugin`')
else
  fail(
    'keywords',
    'no `speqkit-plugin` keyword. It is the one string the registry search and ' +
      '`speq plugins search` look for; without it the plugin works and nobody finds it.'
  )

/* ---- the contract ------------------------------------------------- */

const deps = pkg.dependencies ?? {}
const peers = pkg.peerDependencies ?? {}

if (deps['@speqkit/plugin-api']) {
  fail(
    'plugin-api',
    '`@speqkit/plugin-api` is in `dependencies`. It has to be a peer: the ' +
      'contract comes from the kernel the user installed, and a bundled copy ' +
      'would be checked for compatibility against itself.'
  )
} else if (peers['@speqkit/plugin-api']) {
  good('`@speqkit/plugin-api` is a peer')
} else {
  warn('plugin-api', 'no `@speqkit/plugin-api` peer range declared. Nothing states which contract this was built against.')
}

for (const field of ['dependencies', 'peerDependencies']) {
  if (pkg[field]?.speqkit) {
    fail(
      'kernel',
      `\`speqkit\` is in \`${field}\`. A plugin runs *inside* a kernel and reaches ` +
        'it as `ctx.host`; naming it here ships a second kernel that the installer ' +
        'will put in the store and the plugin will boot.'
    )
  }
}
if (!deps.speqkit && !peers.speqkit) good('does not carry a second kernel')

/* ---- what a consumer actually loads -------------------------------- */

if (!pkg.exports && !pkg.main) {
  fail('exports', 'neither `exports` nor `main`. Nothing can import this.')
} else {
  const targets = pkg.exports ? exportTargets(pkg.exports) : [pkg.main]
  for (const target of targets) {
    const rel = target.replace(/^\.\//, '')
    if (/\.tsx?$/.test(target) && !/\.d\.ts$/.test(target)) {
      fail(
        'exports',
        `\`${target}\` is TypeScript. Node will not strip types inside node_modules, ` +
          'so this is unloadable once installed — and green in any test that resolves ' +
          'the source through a bundler alias.'
      )
      continue
    }
    if (!existsSync(join(dir, rel))) {
      fail('exports', `\`${target}\` does not exist. Run the build before publishing.`)
      continue
    }
    if (!packed(rel)) {
      fail(
        'files',
        `\`${target}\` exists but is not covered by \`files\`: [${(pkg.files ?? []).join(', ')}]. ` +
          'npm packs the manifest, not the directory — the tarball would not contain it.'
      )
      continue
    }
    good(`\`${target}\` is built and packed`)
  }
}

/* ---- what it says about itself ------------------------------------- */

/**
 * A plugin's own documentation, read the way the kernel reads it.
 *
 * `speq docs <name>` answers out of the `docs` block on `definePlugin`, and a
 * plugin that declares none is one whose user's first move after installing it
 * is to open somebody else's source. It is checked here rather than in the
 * contract's types because a plugin declared inside a test file has no
 * documentation and should not have to pretend otherwise — the obligation
 * belongs to a package on its way to a registry.
 *
 * The module is imported, not parsed. That is what the kernel does, so a
 * `docs` block behind a conditional or built by a helper is seen exactly as
 * the kernel would see it.
 */
const entry = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default ?? pkg.main
if (entry && !/\.tsx?$/.test(entry) && existsSync(join(dir, entry.replace(/^\.\//, '')))) {
  let plugin
  try {
    plugin = (await import(pathToFileURL(join(dir, entry.replace(/^\.\//, ''))).href)).default
  } catch (err) {
    // An import that throws is about this machine — an uninstalled peer, a
    // missing build — and not about the plugin. Said out loud, and not counted
    // against it.
    warn('docs', `could not import \`${entry}\` to read its docs (${err.message}).`)
  }

  if (plugin) {
    const docs = plugin.docs
    if (!docs?.summary) {
      fail(
        'docs',
        'no `docs.summary` on definePlugin. `speq docs` is how somebody who just ' +
          'installed this finds out what it is for, and how a model writing a suite ' +
          'is told what it can use — both of them get nothing.'
      )
    } else if (!Array.isArray(docs.examples) || docs.examples.length === 0) {
      fail(
        'docs',
        'a `docs.summary` with no `examples`. One line somebody can paste is worth ' +
          'more than three paragraphs, and it is the form a model can act on.'
      )
    } else if (!docs.examples.every((example) => example?.title && example?.code?.trim())) {
      fail('docs', 'an example with no title or no code.')
    } else {
      good(`says what it is for, with ${docs.examples.length} example(s)`)
      if (!docs.readme) {
        warn('docs', 'no `docs.readme`. A link is where a reader goes when the examples are not enough.')
      }
      if (!docs.examples.some((example) => example.for?.length)) {
        warn(
          'docs',
          "no example names what it demonstrates with `for`. Without it `speq docs <step type>` " +
            'finds nothing, and `speq docs --check` cannot notice a rename.'
        )
      }
    }
  }
}

/* ---- the type declarations ---------------------------------------- */

const types = pkg.exports?.['.']?.types ?? pkg.types
if (types) {
  const rel = types.replace(/^\.\//, '')
  if (!existsSync(join(dir, rel))) fail('types', `\`${types}\` does not exist; consumers get no types.`)
  else if (!packed(rel)) fail('types', `\`${types}\` is not covered by \`files\`.`)
  else good('type declarations ship')
} else {
  warn('types', 'no `types` export. The plugin works; an author writing against it gets no completion.')
}

/* ---- engines ------------------------------------------------------- */

if (!pkg.engines?.node) {
  warn('engines', 'no `engines.node`. The kernel needs >=20, and a user on 18 finds out from a syntax error.')
} else good(`engines.node ${pkg.engines.node}`)

/* ---- the registry --------------------------------------------------- */

let alreadyPublished = null
if (!has('--offline') && pkg.name && pkg.version) {
  try {
    const res = await fetch(`${REGISTRY}/${pkg.name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' }
    })
    if (res.status === 404) {
      alreadyPublished = false
      good(`${pkg.name} has never been published — ${pkg.version} would be the first`)
    } else if (res.ok) {
      const body = await res.json()
      alreadyPublished = Object.keys(body.versions ?? {}).includes(pkg.version)
      if (alreadyPublished) {
        warn(
          'version',
          `${pkg.name}@${pkg.version} is already in the registry. Bump the version, ` +
            'or let the release job skip it — publishing is not a way to change what is there.'
        )
      } else good(`${pkg.name}@${pkg.version} is not in the registry yet`)
    } else {
      warn('registry', `${REGISTRY} answered ${res.status}; skipped the version question.`)
    }
  } catch (err) {
    warn('registry', `could not reach ${REGISTRY} (${err.message}); skipped the version question.`)
  }
}

/* ------------------------------------------------------------------ */
/* Say it                                                              */
/* ------------------------------------------------------------------ */

const report = {
  package: pkg.name,
  version: pkg.version,
  dir: relative(process.cwd(), dir) || '.',
  ok: problems.length === 0,
  alreadyPublished,
  problems,
  notes
}

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const red = (s) => `\x1b[31m${s}\x1b[0m`
  const green = (s) => `\x1b[32m${s}\x1b[0m`
  const yellow = (s) => `\x1b[33m${s}\x1b[0m`
  const dim = (s) => `\x1b[2m${s}\x1b[0m`

  console.log(`\n${pkg.name ?? '(unnamed)'} ${pkg.version ?? ''}  ${dim(report.dir)}\n`)
  for (const p of passed) console.log(`  ${green('ok')}    ${p}`)
  for (const n of notes) console.log(`  ${yellow('note')}  ${n.what}: ${n.why}`)
  for (const p of problems) console.log(`  ${red('FAIL')}  ${p.what}: ${p.why}`)
  console.log()
  console.log(
    problems.length === 0
      ? green('  this would install and load.\n')
      : red(`  ${problems.length} problem(s). Publishing this ships something that does not load.\n`)
  )
}

process.exit(problems.length === 0 ? 0 : 1)
