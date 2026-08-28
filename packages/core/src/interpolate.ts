/**
 * `${...}` resolution against a scope chain.
 *
 * Two forms:
 *   ${login.body.orderId}   a path into step results and variables
 *   ${env:BASE_URL}         a value provider claimed by prefix
 */

export type ValueProviderFn = (key: string) => unknown

export interface ResolveScope {
  /** Innermost first. Each frame is a plain object of names. */
  frames: Record<string, unknown>[]
  providers: Map<string, ValueProviderFn>
}

const TEMPLATE = /\$\{([^}]+)\}/g

export function lookupPath(scope: ResolveScope, path: string): unknown {
  const colon = path.indexOf(':')
  if (colon > 0) {
    const prefix = path.slice(0, colon)
    const provider = scope.providers.get(prefix)
    if (provider) return provider(path.slice(colon + 1))
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
