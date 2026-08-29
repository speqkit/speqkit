#!/usr/bin/env node
/**
 * The standalone executable: step zero of the story, `brew install speqkit`.
 *
 * Everything else in this repository already runs without npm — `speq install`
 * speaks the registry protocol itself and never shells out to a package
 * manager. What that could not remove was the runtime underneath it: a Go team
 * still had to install Node to get a test runner. This produces one file with
 * Node inside it, so they do not.
 *
 *   node scripts/build-binary.mjs [--out <dir>] [--no-archive] [--keep-work]
 *
 * Assumes `pnpm build` has run. It bundles `packages/core/dist`, not `src`,
 * for the same reason verify-publish.mjs packs real tarballs: what we ship
 * should be built out of what we publish, not out of a bundler alias that
 * resolves differently.
 *
 * Node's SEA takes a single CommonJS script, so the kernel, the installer and
 * `yaml` are bundled into one. Plugins are deliberately *not* bundled: they
 * are loaded at run time by absolute path out of `~/.speq`, exactly as under a
 * normal Node, and `import()` inside the blob still reaches the real
 * filesystem. A binary with plugins baked in would be a different product —
 * the one this project exists not to build.
 *
 * The runtime is downloaded from nodejs.org rather than taken from whatever
 * `node` is on PATH. Two reasons, one of which cost an afternoon: a package
 * manager's Node may be a 66 KB stub in front of a shared libnode, and there
 * is nothing to inject a blob into. The other is that the runtime inside a
 * released binary should be a decision, recorded here, and not a property of
 * the machine that happened to run the release job.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The embedded runtime. An LTS line, pinned exactly: bumping it is a visible
 * change to what every user of the binary runs, so it belongs in a diff.
 */
const NODE_RUNTIME = 'v24.20.0'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const version = JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')).version
const platform = process.platform
const arch = process.arch
const exe = 'speq'

if (platform !== 'darwin' && platform !== 'linux') {
  console.error(
    `this script builds for darwin and linux; ${platform} needs the .zip runtime layout and a signtool step.`
  )
  process.exit(1)
}
if (arch !== 'arm64' && arch !== 'x64') {
  console.error(`no official Node build for ${arch}.`)
  process.exit(1)
}

const out = resolve(repo, flag('--out') ?? 'build')
const work = join(out, 'sea')
const cache = join(out, 'runtime')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(cache, { recursive: true })

const step = (label) => console.log(`\x1b[2m→\x1b[0m ${label}`)
const done = (label) => console.log(`  \x1b[32mok\x1b[0m  ${label}`)
const size = (path, unit = 'MB') =>
  unit === 'MB'
    ? `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`
    : `${(statSync(path).size / 1024).toFixed(0)} KB`

console.log(`\nspeqkit ${version} — standalone binary for ${platform}-${arch}`)
console.log(`embedded runtime: node ${NODE_RUNTIME}\n`)

/* ------------------------------------------------------------------ */
/* 1. The runtime to inject into                                       */
/* ------------------------------------------------------------------ */

// `.bin`, because the tarball extracts to a directory of that same name.
const runtime = join(cache, `node-${NODE_RUNTIME}-${platform}-${arch}.bin`)

if (existsSync(runtime)) {
  done(`runtime cached at ${runtime.replace(`${repo}/`, '')}`)
} else {
  const dir = `node-${NODE_RUNTIME}-${platform}-${arch}`
  const file = `${dir}.tar.gz`
  const base = `https://nodejs.org/dist/${NODE_RUNTIME}`

  step(`downloading ${file}`)
  const response = await fetch(`${base}/${file}`)
  if (!response.ok) {
    console.error(`  ${base}/${file} → HTTP ${response.status}`)
    process.exit(1)
  }
  const bytes = Buffer.from(await response.arrayBuffer())

  // The same check the installer performs on every plugin tarball. An
  // unverified runtime would be the one download in this project that is
  // taken on faith, and it is the one that ends up on other people's PATH.
  step('verifying against SHASUMS256.txt')
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === file)?.[0]
  if (!expected) {
    console.error(`  ${file} is not listed in SHASUMS256.txt`)
    process.exit(1)
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    console.error(`  sha256 mismatch\n    expected ${expected}\n    actual   ${actual}`)
    process.exit(1)
  }
  done(`sha256 ${actual.slice(0, 16)}…`)

  const tarball = join(cache, file)
  writeFileSync(tarball, bytes)
  execFileSync('tar', ['-xzf', tarball, '-C', cache, `${dir}/bin/node`], { stdio: 'inherit' })
  copyFileSync(join(cache, dir, 'bin', 'node'), runtime)
  chmodSync(runtime, 0o755)
  rmSync(join(cache, dir), { recursive: true, force: true })
  rmSync(tarball, { force: true })
  done(`runtime ${size(runtime)}`)
}

/* ------------------------------------------------------------------ */
/* 2. One CommonJS file                                                */
/* ------------------------------------------------------------------ */

step('bundling packages/core/dist/bin.js')

const entry = join(repo, 'packages/core/dist/bin.js')
if (!existsSync(entry)) {
  console.error(`${entry} is missing — run 'pnpm build' first.`)
  process.exit(1)
}

const bundle = join(work, 'speq.cjs')
execFileSync(
  join(repo, 'node_modules/.bin/esbuild'),
  [
    entry,
    '--bundle',
    `--outfile=${bundle}`,
    '--platform=node',
    // Matches `engines.node` in every package, and kept high enough that
    // esbuild leaves `import()` alone instead of rewriting it into
    // `require()`, which would break loading an ESM plugin out of the store.
    '--target=node20',
    '--format=cjs',
    '--banner:js=/* speqkit standalone — generated by scripts/build-binary.mjs */',
    '--log-level=warning'
  ],
  { stdio: 'inherit' }
)
done(`${size(bundle, 'KB')} of JavaScript`)

/* ------------------------------------------------------------------ */
/* 3. The SEA blob                                                     */
/* ------------------------------------------------------------------ */

step('preparing the single-executable blob')

const blob = join(work, 'speq.blob')
const seaConfig = join(work, 'sea-config.json')
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      // The warning is addressed to someone experimenting with SEA, not to a
      // tester who typed `speq run`.
      disableExperimentalSEAWarning: true,
      // Startup matters: this binary is on the hot path of every CI job. The
      // cache is V8-version-specific, which is why the blob is built by the
      // very runtime it is injected into rather than by whatever ran this.
      useCodeCache: true
    },
    null,
    2
  )
)
execFileSync(runtime, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' })
done(`${size(blob)} blob`)

/* ------------------------------------------------------------------ */
/* 4. Inject                                                           */
/* ------------------------------------------------------------------ */

step('injecting into the runtime')

const binary = join(out, exe)
rmSync(binary, { force: true })
copyFileSync(runtime, binary)
chmodSync(binary, 0o755)

// macOS refuses to run a Mach-O whose signature no longer matches its
// contents, so the signature comes off before the blob goes in and an ad-hoc
// one goes back on after.
//
// Ad-hoc is where this stops. Notarisation is a decision taken against, not a
// task outstanding: it costs an Apple Developer account and a signing identity
// in CI to buy nothing for the two ways anyone actually installs this. Brew
// clears the quarantine attribute, and a file fetched with curl never gets
// one. Only a browser download is refused by Gatekeeper, and the answer to
// that is the install script rather than a certificate.
if (platform === 'darwin') {
  try {
    execFileSync('codesign', ['--remove-signature', binary], { stdio: 'pipe' })
  } catch {
    // Nothing to remove.
  }
}

execFileSync(
  process.execPath,
  [
    join(repo, 'node_modules/postject/dist/cli.js'),
    binary,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
  ],
  { stdio: 'inherit' }
)

if (platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', binary], { stdio: 'pipe' })
}
done(`${size(binary)} executable`)

/* ------------------------------------------------------------------ */
/* 5. Does it actually run?                                            */
/* ------------------------------------------------------------------ */

step('smoke-testing')

// PATH is emptied for every call here: the whole claim of this artefact is
// that it needs nothing on the machine, and a stray `node` answering on its
// behalf is exactly the way that claim would go untested.
const bare = { ...process.env, PATH: '' }

const reported = execFileSync(binary, ['version'], { encoding: 'utf8', env: bare }).trim()
if (!reported.startsWith('speq ')) {
  console.error(`  'speq version' printed ${JSON.stringify(reported)}`)
  process.exit(1)
}
done(reported)

if (!execFileSync(binary, ['--help'], { encoding: 'utf8', env: bare }).includes('speq install')) {
  console.error(`  'speq --help' does not mention the bootstrap commands`)
  process.exit(1)
}
done('bootstrap commands present')

if (!argv.includes('--keep-work')) rmSync(work, { recursive: true, force: true })

/* ------------------------------------------------------------------ */
/* 6. The archive a release publishes                                  */
/* ------------------------------------------------------------------ */

if (!argv.includes('--no-archive')) {
  step('archiving')
  // Named for the project, containing the command: `speqkit` is what you
  // install, `speq` is what you type. The same split as @angular/cli and ng.
  const name = `speqkit-v${version}-${platform}-${arch}.tar.gz`
  const archive = join(out, name)
  rmSync(archive, { force: true })
  execFileSync('tar', ['-czf', archive, '-C', out, exe], { stdio: 'inherit' })

  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(`${archive}.sha256`, `${sha}  ${name}\n`)
  done(`${name} (${size(archive)})`)
  done(`sha256 ${sha}`)
}

console.log(`\n${binary.replace(`${repo}/`, '')} is ready. It needs no Node on the machine.\n`)
