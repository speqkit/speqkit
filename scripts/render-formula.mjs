#!/usr/bin/env node
/**
 * Fills in packaging/homebrew/speqkit.rb from the checksums a release built.
 *
 *   node scripts/render-formula.mjs --dist <dir> [--version vX.Y.Z] [--out <file>]
 *
 * <dir> is a directory holding the four `speqkit-<version>-<os>-<arch>.tar.gz`
 * archives and their `.sha256` files. The result is copied into
 * speqkit/homebrew-tap as Formula/speqkit.rb.
 *
 * It refuses to render a formula with a platform missing. A tap that is right
 * for three platforms and silently absent on the fourth is worse than no tap:
 * `brew install speqkit` would work for the maintainer and fail for whoever
 * bought the other laptop.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const dist = resolve(repo, flag('--dist') ?? 'build')
const version = flag('--version') ?? `v${JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')).version}`
const template = join(repo, 'packaging/homebrew/speqkit.rb')
const out = flag('--out')

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const base = `https://github.com/speqkit/speqkit/releases/download/${version}`

let formula = readFileSync(template, 'utf8').replaceAll('__VERSION__', version.replace(/^v/, ''))
const missing = []

for (const target of TARGETS) {
  const archive = `speqkit-${version}-${target}.tar.gz`
  const checksum = join(dist, `${archive}.sha256`)
  if (!existsSync(checksum)) {
    missing.push(archive)
    continue
  }
  const sha = readFileSync(checksum, 'utf8').trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    console.error(`${checksum} does not contain a sha256`)
    process.exit(1)
  }
  const key = target.toUpperCase().replace('-', '_')
  formula = formula.replaceAll(`__URL_${key}__`, `${base}/${archive}`).replaceAll(`__SHA_${key}__`, sha)
}

if (missing.length > 0) {
  console.error(
    `cannot render the formula, ${missing.length} platform(s) missing from ${dist}:\n` +
      missing.map((m) => `  ${m}`).join('\n') +
      `\nfound: ${readdirSync(dist).filter((f) => f.endsWith('.tar.gz')).join(', ') || '(nothing)'}`
  )
  process.exit(1)
}

if (formula.includes('__')) {
  console.error(`the template still has unfilled placeholders:\n${formula.match(/__[A-Z0-9_]+__/g).join(', ')}`)
  process.exit(1)
}

if (out) {
  writeFileSync(resolve(repo, out), formula)
  console.log(`wrote ${out} for ${version}`)
} else {
  process.stdout.write(formula)
}
