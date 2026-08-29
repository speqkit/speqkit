import { isGitSpec } from './git.js'

/**
 * Plugin specs, as written in speq.yaml. All four of these name a package in
 * a registry, which is where plugins normally come from:
 *
 *   http                             short name, ours
 *   @speqkit/plugin-http@^2.1.0      full name with a range
 *   speqkit-plugin-kafka             community convention, unscoped
 *   @acme/speqkit-plugin-legacy      a company's private scope
 *
 * Three other kinds exist, and `classifySpec` tells them apart:
 *
 *   github:acme/plugin#v2            a repository — see git.ts
 *   https://acme.dev/plugin-1.0.tgz  a tarball at a URL
 *   ./local/plugin                   a path, resolved by the kernel, not here
 */

export interface PluginSpec {
  /** Exactly what the user wrote. */
  raw: string
  name: string
  range: string
  /** True when the name was a short form and the registry may need a guess. */
  short: boolean
}

export function parseSpec(raw: string): PluginSpec {
  const trimmed = raw.trim()

  // A URL is not a name with a range on the end. `git+ssh://git@host/x.git`
  // has an `@` in it that means something else entirely, and splitting there
  // produces a package called `git+ssh://git` nobody will ever find.
  if (classifySpec(trimmed) !== 'registry') {
    return { raw: trimmed, name: trimmed, range: '*', short: false }
  }

  const at = trimmed.lastIndexOf('@')
  const hasRange = at > 0 && !trimmed.slice(at + 1).includes('/')

  const name = hasRange ? trimmed.slice(0, at) : trimmed
  const range = hasRange ? trimmed.slice(at + 1) : '*'
  const short = !name.includes('/') && !name.startsWith('speqkit-plugin-')

  return { raw: trimmed, name, range, short }
}

/**
 * A short name is a convenience, never a requirement: `http` means
 * `@speqkit/plugin-http`, but a third-party plugin is always named in full so
 * nothing in the ecosystem needs our blessing to be usable.
 */
export function candidates(name: string): string[] {
  if (name.startsWith('.') || name.startsWith('/')) return [name]
  if (name.includes('/') || name.startsWith('speqkit-plugin-')) return [name]
  return [`@speqkit/plugin-${name}`, `speqkit-plugin-${name}`, name]
}

export function isPathSpec(name: string): boolean {
  return name.startsWith('.') || name.startsWith('/') || name.startsWith('file:')
}

export type SpecKind = 'registry' | 'git' | 'tarball' | 'path'

/** A URL ending in a tarball extension, and nothing else over plain http. */
const TARBALL = /^https?:\/\/\S+\.(tgz|tar\.gz)(\?\S*)?$/i

/**
 * Which of the four sources a spec names.
 *
 * The one case worth spelling out is a bare `https://` URL that is not a
 * tarball. Left to fall through it would be looked up as a package whose name
 * begins with `https:`, and the 404 would send the reader looking in exactly
 * the wrong place.
 */
export function classifySpec(raw: string): SpecKind {
  const spec = raw.trim()
  if (isPathSpec(spec)) return 'path'
  if (isGitSpec(spec)) return 'git'
  if (TARBALL.test(spec)) return 'tarball'
  if (/^https?:/i.test(spec)) {
    throw new Error(
      `'${spec}' is a URL but not a tarball, and speq will not guess what is at the other end.\n` +
        `  A repository: git+${spec}#<ref>, or github:owner/repo#<ref>\n` +
        `  A packed tarball: the URL has to end in .tgz or .tar.gz`
    )
  }
  return 'registry'
}
