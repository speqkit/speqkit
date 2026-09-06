import type { InputSchema } from '@speqkit/plugin-api'

/**
 * The structural check a step's or an assertion's input gets before the run.
 *
 * `InputSchema` is JSON-Schema-shaped, and for a long time the kernel read two
 * words of it: `required`, and `additionalProperties: false`. That was enough
 * to catch `bodyRaw:` where `body:` was meant — the bug the closed schema was
 * introduced for — and not enough to catch `method: GETT`, `attempts: "3"`, or
 * `retry: { attemps: 3 }`, because a nested object was never opened and a
 * type was never compared. Every one of those went out on the wire and came
 * back as a failed step, which is exactly the class of mistake `speq validate`
 * exists to find in milliseconds instead.
 *
 * What is checked, and it is the whole list: `type` (one or several, and
 * `integer`), `enum`, `const`, `properties` with `required` and
 * `additionalProperties` at every depth, `items`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, and `anyOf`,
 * `oneOf`, `allOf`. A keyword outside that list is not applied — a plugin
 * that wants `$ref`, `if`/`then` or a format goes through its own `validate`
 * with a real validator, the way `plugin-assert` does for `schema`. The one
 * `$ref` the contract itself hands out, `STEPS_SCHEMA`, stands for "a list of
 * steps", and the kernel walks those steps itself.
 *
 * **A whole-template value satisfies any schema.** `attempts: ${vars:tries}`
 * is a string here and a number at run time, and the kernel has no way to
 * know which; refusing it would refuse every parametrised input in the suite.
 * A string with a template *inside* it — `"Bearer ${token}"` — is a string
 * whatever the template resolves to, and is checked as one.
 */

export interface SchemaProblem {
  code: 'missing-field' | 'unknown-field' | 'invalid-value'
  /** Dotted path inside the input, empty at the top. */
  path: string
  message: string
}

const WHOLE_TEMPLATE = /^\$\{[^}]+\}$/

/**
 * `reserved` is what the kernel owns on the subject whatever its schema says —
 * `id`, `type`, `timeout`, `steps`, `assert` and `meta` on a step; `type` and
 * `meta` on an assertion — and is allowed at the top level only. It used to be
 * the step's list for both, so an assertion could carry an `id:` or a
 * `steps:` and nothing would say so.
 */
export function checkAgainstSchema(value: unknown, schema: InputSchema, reserved: readonly string[] = []): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  check(value, schema, '', problems, reserved)
  return problems
}

function check(value: unknown, schema: InputSchema, path: string, out: SchemaProblem[], reserved: readonly string[] = []): void {
  if (typeof value === 'string' && WHOLE_TEMPLATE.test(value)) return

  const label = path || 'the input'

  if (schema.type !== undefined && !hasType(value, schema.type)) {
    out.push({
      code: 'invalid-value',
      path,
      message: `${label} is ${describe(value)}, not ${expected(schema.type)}`
    })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) {
    out.push({
      code: 'invalid-value',
      path,
      message: `${label} is ${describe(value)}, not one of ${schema.enum.map(show).join(', ')}`
    })
    return
  }
  if (schema.const !== undefined && !same(schema.const, value)) {
    out.push({ code: 'invalid-value', path, message: `${label} is ${describe(value)}, not ${show(schema.const)}` })
    return
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push({ code: 'invalid-value', path, message: `${label} is ${value}, below the minimum of ${schema.minimum}` })
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push({ code: 'invalid-value', path, message: `${label} is ${value}, above the maximum of ${schema.maximum}` })
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push({ code: 'invalid-value', path, message: `${label} is shorter than ${schema.minLength} character(s)` })
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      out.push({ code: 'invalid-value', path, message: `${label} is longer than ${schema.maxLength} character(s)` })
    }
    if (typeof schema.pattern === 'string' && !safeRegExp(schema.pattern)?.test(value)) {
      out.push({ code: 'invalid-value', path, message: `${label} is ${show(value)}, which does not match /${schema.pattern}/` })
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push({ code: 'invalid-value', path, message: `${label} has ${value.length} item(s), fewer than ${schema.minItems}` })
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push({ code: 'invalid-value', path, message: `${label} has ${value.length} item(s), more than ${schema.maxItems}` })
    }
    if (isSchema(schema.items)) {
      value.forEach((item, index) => check(item, schema.items as InputSchema, `${path}[${index}]`, out))
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : undefined
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) {
        out.push({ code: 'missing-field', path, message: `missing required field '${join(path, key)}'` })
      }
    }
    if (properties) {
      for (const [key, sub] of Object.entries(properties)) {
        if (value[key] !== undefined && isSchema(sub)) check(value[key], sub, join(path, key), out)
      }
    }
    if (schema.additionalProperties === false || isSchema(schema.additionalProperties)) {
      const allowed = new Set([...Object.keys(properties ?? {}), ...(path === '' ? reserved : [])])
      for (const key of Object.keys(value)) {
        if (allowed.has(key)) continue
        if (schema.additionalProperties === false) {
          out.push({
            code: 'unknown-field',
            path,
            message: `unknown field '${join(path, key)}'${available(key, [...allowed])}`
          })
        } else {
          check(value[key], schema.additionalProperties as InputSchema, join(path, key), out)
        }
      }
    }
  }

  for (const branches of [schema.allOf]) {
    if (Array.isArray(branches)) {
      for (const branch of branches) if (isSchema(branch)) check(value, branch, path, out)
    }
  }
  for (const [word, want] of [['anyOf', 'any'], ['oneOf', 'one']] as const) {
    const branches = schema[word]
    if (!Array.isArray(branches)) continue
    const inner = path === '' ? reserved : []
    const shapes = branches.filter(isSchema)
    const matching = shapes.filter((b) => checkAgainstSchema(value, b, inner).length === 0).length
    if ((want === 'any' && matching > 0) || (want === 'one' && matching === 1)) continue

    // "Matches none of the shapes" names nothing to fix. When exactly one
    // branch is the kind of thing that was written — a mapping, say — it is
    // the one the author meant, and its own complaints are the useful ones:
    // `filenam` under a file part is a typo, not a shape.
    const meant = shapes.filter((b) => b.type !== undefined && hasType(value, b.type))
    if (matching === 0 && meant.length === 1) {
      check(value, meant[0]!, path, out, inner)
      continue
    }
    out.push({
      code: 'invalid-value',
      path,
      message: `${label} is ${describe(value)}, which matches ${matching === 0 ? 'none' : `${matching}`} of the ${shapes.length} shapes it may take`
    })
  }
}

function hasType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type]
  return types.some((t) => {
    switch (t) {
      case 'string': return typeof value === 'string'
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'boolean': return typeof value === 'boolean'
      case 'null': return value === null
      case 'array': return Array.isArray(value)
      case 'object': return isPlainObject(value)
      default: return true
    }
  })
}

function expected(type: unknown): string {
  const types = (Array.isArray(type) ? type : [type]).map(String)
  const words = types.map((t) => (t === 'object' ? 'a mapping' : t === 'array' ? 'a list' : t === 'integer' ? 'a whole number' : `a ${t}`))
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words[0]!
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (isPlainObject(value)) return 'a mapping'
  if (typeof value === 'string') return show(value)
  return String(value)
}

function show(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value) ?? String(value)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSchema(value: unknown): value is InputSchema {
  return isPlainObject(value)
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

/** The nearest allowed name, or the whole list, in the form `suggest` uses. */
function available(key: string, allowed: string[]): string {
  const near = allowed
    .map((k) => [k, distance(key, k)] as const)
    .filter(([, d]) => d <= 2)
    .sort((a, b) => a[1] - b[1])[0]
  if (near) return ` — did you mean '${near[0]}'?`
  return allowed.length ? ` — available: ${allowed.sort().join(', ')}` : ''
}

export function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[a.length]![b.length]!
}
