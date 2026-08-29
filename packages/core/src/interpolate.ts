/**
 * `${...}` resolution against a scope chain.
 *
 * Two forms:
 *   ${login.body.orderId}   a path into step results and variables
 *   ${env:BASE_URL}         a value provider claimed by prefix
 *
 * A provider may answer asynchronously — a secret from a vault, a row from a
 * database — and that is why resolution comes in two halves. `prime` asks the
 * providers, awaiting them all at once; the walk that fills the `${...}` in is
 * synchronous and reads their answers out of the map `prime` returned.
 *
 * Splitting it this way is what keeps `ExecContext.resolve` and
 * `resolveDeep` synchronous for plugins. Had `await` gone into the walk it
 * would have surfaced in the contract, and every plugin resolving a template
 * by hand would have had to become async for a provider it never uses.
 */

export type ValueProviderFn = (key: string) => unknown | Promise<unknown>

export interface ResolveScope {
  /** Innermost first. Each frame is a plain object of names. */
  frames: Record<string, unknown>[]
  providers: Map<string, ValueProviderFn>
  /**
   * What the providers already answered in this pass, keyed `prefix:key`.
   * Filled by `prime`, read by `lookupPath`, and thrown away with the pass.
   */
  resolved?: ReadonlyMap<string, unknown>
}

const TEMPLATE = /\$\{([^}]+)\}/g

export function lookupPath(scope: ResolveScope, path: string): unknown {
  const colon = path.indexOf(':')
  if (colon > 0) {
    const prefix = path.slice(0, colon)
    const provider = scope.providers.get(prefix)
    if (provider) {
      if (scope.resolved?.has(path)) return scope.resolved.get(path)
      const value = provider(path.slice(colon + 1))
      if (isThenable(value)) throw new AsyncProviderError(prefix, path)
      return value
    }
  }

  const segments = splitPath(path)
  const head = segments[0]
  if (head === undefined) return undefined

  for (const frame of scope.frames) {
    if (Object.prototype.hasOwnProperty.call(frame, head)) {
      return walk(frame[head], segments.slice(1), path)
    }
  }
  throw new UnresolvedError(path, head)
}

/**
 * Raised where a `${...}` naming an asynchronous provider cannot be awaited.
 *
 * speq primes every template it resolves itself — a step's input, an
 * assertion's — so this is only reachable from `exec.resolve()`, which the
 * contract declares synchronous and cannot be made to wait.
 */
export class AsyncProviderError extends Error {
  constructor(
    readonly prefix: string,
    readonly path: string
  ) {
    super(
      `cannot resolve \${${path}} here: value provider '${prefix}' answers asynchronously. ` +
        'speq awaits it where it resolves a step input or an assertion; ' +
        'exec.resolve() is synchronous and cannot.'
    )
    this.name = 'AsyncProviderError'
  }
}

export class UnresolvedError extends Error {
  constructor(
    readonly path: string,
    readonly missing: string
  ) {
    super(`cannot resolve \${${path}}: '${missing}' is not defined`)
    this.name = 'UnresolvedError'
  }
}

function splitPath(path: string): string[] {
  // a.b[0].c -> ['a','b','0','c']
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
}

function walk(value: unknown, rest: string[], full: string): unknown {
  let current = value
  for (const segment of rest) {
    if (current === null || current === undefined) {
      throw new UnresolvedError(full, segment)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** A string that is exactly one template keeps the resolved value's type. */
export function resolveString(scope: ResolveScope, input: string): unknown {
  const whole = input.match(/^\$\{([^}]+)\}$/)
  if (whole?.[1]) return lookupPath(scope, whole[1].trim())

  return input.replace(TEMPLATE, (_m, expr: string) => {
    const value = lookupPath(scope, expr.trim())
    return value === null || value === undefined ? '' : String(value)
  })
}

/**
 * Ask every provider a template in `value` names, all at once.
 *
 * A provider is asked once per pass, not once per `${...}`: two mentions of
 * `${env:HOME}` in one step are one lookup. That is the right shape for what a
 * provider is — a lookup, not a generator — and the pass is short enough that
 * a value written between two steps is still read fresh by the second.
 */
export async function prime(scope: ResolveScope, value: unknown): Promise<Map<string, unknown>> {
  const wanted: { path: string; key: string; provider: ValueProviderFn }[] = []
  const seen = new Set<string>()

  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const [, expr] of node.matchAll(TEMPLATE)) {
        const path = (expr ?? '').trim()
        const colon = path.indexOf(':')
        if (colon <= 0 || seen.has(path)) continue
        const provider = scope.providers.get(path.slice(0, colon))
        if (!provider) continue
        seen.add(path)
        wanted.push({ path, key: path.slice(colon + 1), provider })
      }
    } else if (Array.isArray(node)) node.forEach(collect)
    else if (node && typeof node === 'object') Object.values(node).forEach(collect)
  }
  collect(value)

  const resolved = new Map<string, unknown>()
  if (wanted.length === 0) return resolved

  // Settled rather than raced, so a failing provider reports the same problem
  // whichever one happens to reject first: the first in the template's order.
  const answers = await Promise.allSettled(wanted.map((w) => w.provider(w.key)))
  for (const [index, answer] of answers.entries()) {
    if (answer.status === 'rejected') throw answer.reason
    resolved.set(wanted[index]!.path, answer.value)
  }
  return resolved
}

/** `resolveDeep`, with the providers awaited first. */
export async function resolveDeepAsync<T>(scope: ResolveScope, value: T): Promise<T> {
  return resolveDeep({ ...scope, resolved: await prime(scope, value) }, value)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function'
}

export function resolveDeep<T>(scope: ResolveScope, value: T): T {
  if (typeof value === 'string') return resolveString(scope, value) as T
  if (Array.isArray(value)) return value.map((v) => resolveDeep(scope, v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(scope, v)
    }
    return out as T
  }
  return value
}
