export interface PackageManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  engines?: Record<string, string>
  deprecated?: string
  dist: { tarball: string; integrity?: string; shasum?: string }
}

export interface Packument {
  name: string
  'dist-tags'?: Record<string, string>
  versions: Record<string, PackageManifest>
}

export interface RegistryClient {
  packument(name: string): Promise<Packument>
  tarball(url: string): Promise<Uint8Array>
}

export interface NpmRegistryOptions {
  registry?: string
  /** Bearer token for a private scope. Read from NPM_TOKEN when unset. */
  token?: string
  fetch?: typeof globalThis.fetch
}

/**
 * The registry is npm; the installer is ours.
 *
 * That split is the whole distribution story. Building a registry would mean
 * building auth, mirroring, takedowns and trust — for nothing, since every
 * plugin author already has an npm account. Building the installer, on the
 * other hand, is what keeps `node_modules` out of a Go repository: this
 * speaks the registry's HTTP API directly and never shells out to a package
 * manager the user may not have.
 */
export function npmRegistry(options: NpmRegistryOptions = {}): RegistryClient {
  const base = (options.registry ?? process.env.SPEQ_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const token = options.token ?? process.env.NPM_TOKEN
  const doFetch = options.fetch ?? globalThis.fetch

  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`

  return {
    async packument(name) {
      const url = `${base}/${name.replace('/', '%2F')}`
      const response = await doFetch(url, {
        headers: { ...headers, accept: 'application/vnd.npm.install-v1+json' }
      })
      if (response.status === 404) {
        throw new Error(`no package '${name}' in the registry at ${base}`)
      }
      if (!response.ok) {
        throw new Error(`registry answered ${response.status} for '${name}' at ${base}`)
      }
      return (await response.json()) as Packument
    },

    async tarball(url) {
      // The token goes to the registry and nowhere else. A packument names
      // the host its own tarballs live on, and a spec in speq.yaml can name
      // any host at all; sending a private-scope credential to whichever one
      // turned up in a URL is how a token leaves the building.
      const response = await doFetch(url, { headers: sameOrigin(url, base) ? headers : {} })
      if (!response.ok) {
        throw new Error(`could not download ${url}: answered ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    }
  }
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}
