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
 *
 * Assumes `pnpm build` has run.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run_ = promisify(execFile)
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGES = ['plugin-api', 'installer', 'core', 'plugin-yaml', 'plugin-cli', 'plugin-loop', 'plugin-junit']

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
/* 3. A project with no node_modules at all                            */
/* ------------------------------------------------------------------ */

mkdirSync(join(project, 'suites'), { recursive: true })
writeFileSync(
  join(project, 'speq.yaml'),
  'version: 1\n\nplugins:\n  - yaml\n  - cli\n  - loop\n  - junit\n'
)
writeFileSync(
  join(project, 'suites', 'smoke.yaml'),
  'name: the loop runs\n\nsteps:\n' +
    '  - id: three\n    type: loop\n    times: 3\n    steps:\n      - type: loop\n        times: 1\n        steps: []\n'
)

/**
 * Async on purpose. The registry above lives in *this* process's event loop, so
 * a synchronous child would block the very server it is about to call and the
 * whole thing would deadlock — which is exactly what it did the first time.
 */
const speq = async (args, extraEnv = {}) => {
  const env = { ...process.env, SPEQ_HOME: store, SPEQ_REGISTRY: base, ...extraEnv }
  try {
    const { stdout, stderr } = await run_(process.execPath, [join(repo, 'packages/core/dist/bin.js'), ...args], {
      cwd: project,
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

server.close()
console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m — what we publish installs and runs\n' : `\n\x1b[31m${failures} failure(s)\x1b[0m\n`)
if (failures === 0 && !process.env.KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept at ${scratch}\n`)
process.exit(failures === 0 ? 0 : 1)
