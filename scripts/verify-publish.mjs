#!/usr/bin/env node
/**
 * The release smoke test: does what we publish actually install and run?
 *
 * Every other test in this repository runs against `src` through a bundler
 * alias, which is exactly the arrangement that hid the fact that `exports`
 * pointed at TypeScript and Node refuses to strip types inside `node_modules`.
 * This script trusts none of that. It packs the real tarballs, serves them from
 * a throwaway registry over HTTP, installs them into a throwaway store, and
 * runs the CLI out of `dist` with plain `node`.
 *
 *   node scripts/verify-publish.mjs
 *   node scripts/verify-publish.mjs --binary build/speq
 *
 * The second form points the same battery at the standalone executable with
 * an empty PATH, so the artefact a `brew install` produces has to pass what
 * the published packages pass. Two ways of shipping, one definition of works.
 *
 * Assumes `pnpm build` has run — and, for --binary, that
 * `node scripts/build-binary.mjs` has too.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run_ = promisify(execFile)
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * What is being tested: the published `dist` under the Node on this machine,
 * or the standalone binary, which is supposed to need no Node at all.
 */
const binaryFlag = process.argv.indexOf('--binary')
const binary = binaryFlag >= 0 ? resolve(repo, process.argv[binaryFlag + 1]) : undefined
// Every package we would publish. `plugin-http` and `plugin-playwright` were
// missing here, and `speq init` scaffolds a config that names `http` — so the
// plugin a new project loads first was the one this never checked.
const PACKAGES = [
  'plugin-api', 'installer', 'core',
  'plugin-yaml', 'plugin-cli', 'plugin-loop', 'plugin-junit', 'plugin-http', 'plugin-playwright'
]

const scratch = mkdtempSync(join(tmpdir(), 'speqkit-verify-'))
const tarballs = join(scratch, 'tarballs')
const store = join(scratch, 'store')
const project = join(scratch, 'project')
mkdirSync(tarballs, { recursive: true })

let failures = 0
const ok = (label) => console.log(`  \x1b[32mok\x1b[0m    ${label}`)
const bad = (label, detail) => {
  failures++
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}`)
  if (detail) console.log(`        ${String(detail).split('\n').join('\n        ')}`)
}

/* ------------------------------------------------------------------ */
/* 1. Pack what we would publish                                       */
/* ------------------------------------------------------------------ */

console.log(
  binary
    ? `\nsubject: ${binary.replace(`${repo}/`, '')} — standalone, PATH emptied`
    : `\nsubject: packages/*/dist under node ${process.version}`
)
if (binary && !existsSync(binary)) {
  console.error(`${binary} is missing — run 'node scripts/build-binary.mjs' first.`)
  process.exit(1)
}

console.log('\npacking')
for (const name of PACKAGES) {
  execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
    cwd: join(repo, 'packages', name),
    stdio: 'pipe'
  })
}

const registry = new Map()
for (const file of readdirSync(tarballs)) {
  const body = readFileSync(join(tarballs, file))
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', join(tarballs, file), 'package/package.json'], { encoding: 'utf8' })
  )
  registry.set(manifest.name, { manifest, body })
  console.log(`  ${manifest.name}@${manifest.version}  ${(body.length / 1024).toFixed(1)}kb`)
}

/* ------------------------------------------------------------------ */
/* 2. Serve them as a registry                                         */
/* ------------------------------------------------------------------ */

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url ?? '')
  if (path.startsWith('/tarball/')) {
    const entry = registry.get(path.slice('/tarball/'.length))
    if (!entry) return res.writeHead(404).end()
    return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(entry.body)
  }
  const entry = registry.get(path.slice(1))
  if (!entry) {
    // Anything that is not ours is proxied to the real npm. Our packages have
    // ordinary third-party dependencies — `yaml`, `semver` — and a harness that
    // could not resolve them would be testing a graph nobody ever installs.
    return fetch(`https://registry.npmjs.org${path}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' }
    })
      .then(async (upstream) => {
        const body = Buffer.from(await upstream.arrayBuffer())
        res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(body)
      })
      .catch(() => res.writeHead(502).end('{}'))
  }
  const { manifest, body } = entry
  const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      name: manifest.name,
      'dist-tags': { latest: manifest.version },
      versions: {
        [manifest.version]: {
          ...manifest,
          dist: { tarball: `${base}/tarball/${manifest.name}`, integrity }
        }
      }
    })
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

/* ------------------------------------------------------------------ */
/* 3. A system under test, and a project with no node_modules at all   */
/* ------------------------------------------------------------------ */

/**
 * Local on purpose. `plugin-http` needs something to talk to, and pointing the
 * release smoke test at a public API would make our build fail whenever
 * someone else's went down.
 */
const sut = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 1, ok: true }))
})
await new Promise((r) => sut.listen(0, '127.0.0.1', r))
const sutBase = `http://127.0.0.1:${sut.address().port}`

mkdirSync(join(project, 'suites'), { recursive: true })
writeFileSync(
  join(project, 'speq.yaml'),
  'version: 1\n\nplugins:\n  - yaml\n  - cli\n  - loop\n  - junit\n  - http\n  - playwright\n\n' +
    `http:\n  baseUrl: ${sutBase}\n`
)
writeFileSync(
  join(project, 'suites', 'smoke.yaml'),
  'name: the loop runs\n\nsteps:\n' +
    '  - id: three\n    type: loop\n    times: 3\n    steps:\n      - type: loop\n        times: 1\n        steps: []\n'
)
writeFileSync(
  join(project, 'suites', 'http.yaml'),
  'name: http reaches the service\n\nsteps:\n' +
    '  - id: root\n    type: http\n    method: GET\n    url: /health\n\n' +
    'assert:\n  - type: status\n    expected: 200\n  - type: jsonpath\n    path: id\n    expected: 1\n'
)

/**
 * Async on purpose. The registry above lives in *this* process's event loop, so
 * a synchronous child would block the very server it is about to call and the
 * whole thing would deadlock — which is exactly what it did the first time.
 */
const speq = async (args, extraEnv = {}, cwd = project) => {
  const env = { ...process.env, SPEQ_HOME: store, SPEQ_REGISTRY: base, ...extraEnv }
  // Emptied under --binary, and only there: the entire claim of that artefact
  // is that the machine needs nothing on it, and a `node` still answering from
  // PATH is precisely how that claim would go untested.
  if (binary) env.PATH = ''
  const [command, argv] = binary
    ? [binary, args]
    : [process.execPath, [join(repo, 'packages/core/dist/bin.js'), ...args]]
  try {
    const { stdout, stderr } = await run_(command, argv, {
      cwd,
      env,
      encoding: 'utf8'
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (err) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Install, load, run — all from the store                          */
/* ------------------------------------------------------------------ */

console.log('\ninstalling from the throwaway registry')
const install = await speq(['install'])
console.log(install.out.split('\n').map((l) => `  ${l}`).join('\n').trimEnd())
if (install.code !== 0) bad('speq install exits 0', install.out)
else ok('speq install exits 0')

/**
 * The kernel must not be in the store.
 *
 * `plugin-cli` used to declare `speqkit` as an ordinary dependency, and
 * the installer did exactly as told: it put a second kernel in here, linked it
 * under the plugin, and pinned it in speq.lock. The plugin then booted it —
 * so `speq run` loaded every plugin twice, into two registries, and the kernel
 * that answered was the locked one rather than the one the user installed.
 * Plugins reach the kernel through `ctx.host`; nothing they publish may name
 * it. This is the check at the boundary that actually matters, because it is
 * the graph a stranger installs rather than the one we build.
 */
const installed = readdirSync(join(store, 'store'))
const kernels = installed.filter((n) => n.startsWith('speqkit@') || n.startsWith('@speqkit+installer@'))
kernels.length === 0
  ? ok('the store holds plugins only, no kernel')
  : bad('the store holds plugins only, no kernel', `found ${kernels.join(', ')}`)

/**
 * An optional peer is skipped, not installed.
 *
 * `plugin-playwright` declares `playwright` as an optional peer, and the
 * branch in the installer that honours that had never been walked by anything
 * end to end. If it regressed, every project that so much as lists the plugin
 * would start pulling a browser driver it may not want.
 */
installed.some((n) => n.startsWith('playwright@'))
  ? bad('the optional playwright peer stays out of the store', `store: ${installed.join(', ')}`)
  : ok('the optional playwright peer stays out of the store')

const plugins = await speq(['plugins'])
if (plugins.code !== 0) {
  bad('speq plugins loads them back', plugins.out)
} else {
  console.log('\n' + plugins.out.split('\n').map((l) => `  ${l}`).join('\n').trimEnd())
  const fromNodeModules = plugins.out.includes('node_modules')
  fromNodeModules
    ? bad('every plugin came from the store, not node_modules', plugins.out)
    : ok('every plugin came from the store, not node_modules')
}

const run = await speq(['run'])
console.log('\n' + run.out.split('\n').map((l) => `  ${l}`).join('\n').trimEnd())
run.code === 0 ? ok('speq run passes') : bad(`speq run passes (exit ${run.code})`, '')

const frozen = await speq(['install', '--frozen'], { SPEQ_REGISTRY: 'http://127.0.0.1:1' })
frozen.code === 0
  ? ok('--frozen replays the lock with the registry unreachable')
  : bad('--frozen replays the lock with the registry unreachable', frozen.out)

/* ------------------------------------------------------------------ */
/* 5. A plugin that never went near a registry                         */
/* ------------------------------------------------------------------ */

/**
 * `git+file://` is a real remote as far as git is concerned, so this walks
 * exactly the code `github:acme/plugin` walks — ls-remote, a shallow fetch of
 * one commit, the checkout, the store — with no fixture host to stand up.
 *
 * Skipped against the standalone binary, and the reason is the point of that
 * mode rather than a gap in it: PATH is emptied there to prove the machine
 * needs nothing, and a git spec is the one thing that does need something.
 */
if (binary) {
  console.log(`\n  \x1b[2mskip  git specs: --binary runs with PATH emptied, and git is the one thing they need\x1b[0m`)
} else {
  console.log('\ninstalling a plugin out of a repository')

  const repo = join(scratch, 'plugin-repo')
  const gitProject = join(scratch, 'git-project')
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'speqkit-plugin-fromgit', version: '1.4.0', type: 'module', main: 'dist/index.js' })
  )
  writeFileSync(
    join(repo, 'dist', 'index.js'),
    `export default {\n` +
      `  name: 'speqkit-plugin-fromgit',\n` +
      `  setup(ctx) {\n` +
      `    ctx.defineStepType('fromgit', { execute: () => ({ body: { ok: true } }) })\n` +
      `  }\n` +
      `}\n`
  )
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'speq', GIT_AUTHOR_EMAIL: 'speq@example.com',
        GIT_COMMITTER_NAME: 'speq', GIT_COMMITTER_EMAIL: 'speq@example.com'
      }
    }).trim()

  git(['init', '--quiet', '--initial-branch', 'main'])
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'a plugin nobody published'])
  git(['tag', 'v1.4.0'])
  const commit = git(['rev-parse', 'HEAD'])

  mkdirSync(join(gitProject, 'suites'), { recursive: true })
  writeFileSync(
    join(gitProject, 'speq.yaml'),
    `version: 1\n\nplugins:\n  - yaml\n  - cli\n  - "git+file://${repo}#v1.4.0"\n`
  )
  writeFileSync(
    join(gitProject, 'suites', 'fromgit.yaml'),
    'name: a plugin from a repository contributes a step\n\nsteps:\n  - id: it\n    type: fromgit\n'
  )

  const gitInstall = await speq(['install'], {}, gitProject)
  console.log(gitInstall.out.split('\n').map((l) => `  ${l}`).join('\n').trimEnd())
  gitInstall.code === 0 ? ok('a git spec installs') : bad('a git spec installs', gitInstall.out)

  // The commit, never the tag. A tag moves, and CI has to install the code
  // that was reviewed rather than whatever the tag points at that morning.
  const gitLock = readFileSync(join(gitProject, 'speq.lock'), 'utf8')
  gitLock.includes(`#${commit}`)
    ? ok('the lock pins the commit, not the ref')
    : bad('the lock pins the commit, not the ref', gitLock)

  const gitRun = await speq(['run'], {}, gitProject)
  gitRun.code === 0
    ? ok('its step type runs')
    : bad(`its step type runs (exit ${gitRun.code})`, gitRun.out)

  // The store is thrown away and the tag deleted: only the lock knows where
  // the code is now. This is the CI case, and the only one that matters.
  git(['tag', '-d', 'v1.4.0'])
  const replay = await speq(['install', '--frozen'], { SPEQ_HOME: join(scratch, 'cold-store') }, gitProject)
  replay.code === 0
    ? ok('--frozen replays the commit into a cold store with the tag deleted')
    : bad('--frozen replays the commit into a cold store with the tag deleted', replay.out)
}

/* ------------------------------------------------------------------ */

server.close()
sut.close()
console.log(
  failures === 0
    ? `\n\x1b[32mall good\x1b[0m — ${binary ? 'the binary installs and runs with nothing on the machine' : 'what we publish installs and runs'}\n`
    : `\n\x1b[31m${failures} failure(s)\x1b[0m\n`
)
if (failures === 0 && !process.env.KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept at ${scratch}\n`)
process.exit(failures === 0 ? 0 : 1)
