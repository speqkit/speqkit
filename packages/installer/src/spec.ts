/**
 * Plugin specs, as written in speq.yaml. All four of these are the same thing:
 *
 *   http                          short name, ours
 *   @speqkit/plugin-http@^2.1.0      full name with a range
 *   speqkit-plugin-kafka             community convention, unscoped
 *   @acme/speqkit-plugin-legacy      a company's private scope
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

/**
 * Everything the registry cannot answer for.
 *
 * The design promises git and tarball URLs eventually; until they exist, a
 * spec that names one has to say so. Left alone it becomes a 404 for a
 * package called `github:acme/thing`, which sends the reader looking in
 * exactly the wrong place.
 */
const NON_REGISTRY = /^(github|gitlab|bitbucket|git|git\+https?|git\+ssh|https?):/i

export function assertRegistrySpec(spec: string): void {
  const match = NON_REGISTRY.exec(spec.trim())
  if (!match) return
  throw new Error(
    `'${spec}' is a ${match[1]} source, and this build installs from the npm registry only.\n` +
      `  A local checkout works today: speq link <path>\n` +
      `  So does a private registry, via SPEQ_REGISTRY and NPM_TOKEN.`
  )
}
