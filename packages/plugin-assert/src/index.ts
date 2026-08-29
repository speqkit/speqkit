import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import formats from 'ajv-formats'
import {
  definePlugin, type AssertContext, type AssertOutcome, type AssertionDef, type PluginContext,
  type ValidationProblem
} from '@speqkit/plugin-api'

/**
 * The vocabulary a test says what it means in.
 *
 * Every assertion here is the same two questions: *what* are we looking at,
 * and *what must be true of it*. The first is one selector shared by all of
 * them, the second is the assertion's type — so learning the plugin is
 * learning one selector and a list of words, rather than a shape per check.
 *
 * The list is wide on purpose, and that is not the same as deep. A team that
 * cannot write "at least" or "is one of" writes it as a regex over a
 * stringified body, and the suite stops saying what it means; a vocabulary is
 * language, and language is where the line between our plugins and somebody
 * else's runs. What it deliberately does not have is a domain: nothing here
 * knows about HTTP, SQL or a browser, which is why the same `at_least` works
 * over all three.
 */

interface AssertConfig {
  /** Where `schema` looks for its files, relative to the project root. */
  schemasDir?: string
}

/** What an assertion is looking at, once the selector has been read. */
interface Subject {
  /** How to name it in a message — the path, or what stood in for one. */
  label: string
  value: unknown
  /** False when a `path` was written and nothing was there. */
  found: boolean
}

/** One entry of the vocabulary. */
interface Check {
  /** Completes "expected <subject> …" in a failure message. */
  phrase(input: Record<string, unknown>): string
  holds(subject: Subject, input: Record<string, unknown>): boolean
  /** Keys this check needs beyond the selector. `expected` unless stated. */
  needs?: string[]
  /** Extra input keys, beyond the selector and `needs`. */
  takes?: Record<string, unknown>
  /** Set when the check is about presence and must see a missing path itself. */
  tolerantOfMissing?: boolean
}

export default definePlugin({
  name: '@speqkit/plugin-assert',
  configSchema: {
    type: 'object',
    properties: { schemasDir: { type: 'string' } },
    additionalProperties: false
  },

  setup(ctx) {
    for (const [name, check] of Object.entries(VOCABULARY)) define(ctx, name, check)
    defineSchemaCheck(ctx)
    defineBridges(ctx)
  }
})

/* ------------------------------------------------------------------ */
/* The selector — one way of saying what an assertion is looking at    */
/* ------------------------------------------------------------------ */

/**
 * `path` reads into the step's whole result, not into its body.
 *
 * An HTTP step returns `{ status, body, text, headers, … }`, so a check on the
 * payload is written `path: body.items[0].sku`. The extra word buys the thing
 * that makes this plugin worth having: the same `at_least` reads a SQL row and
 * a file's contents, because nothing here believes it is looking at a
 * response.
 */
const SELECTOR = {
  path: { type: 'string' },
  value: {}
} as const

function subjectOf(ctx: AssertContext, input: Record<string, unknown>): Subject {
  if (Object.hasOwn(input, 'value')) return { label: 'the value', value: input.value, found: true }
  if (typeof input.path === 'string') {
    const value = readPath(ctx.last, input.path)
    return { label: input.path, value, found: value !== undefined }
  }
  return { label: 'the result', value: ctx.last, found: ctx.last !== undefined }
}

function readPath(from: unknown, path: string): unknown {
  let current = from
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Checks the selector before the run — and refuses the v1 spelling by name.
 *
 * `$.name` was a JSONPath into the response body. Left alone it would resolve
 * to nothing and report that `$` is not a field, which is true and useless.
 */
function checkSelector(assertion: AssertionDef): ValidationProblem[] {
  const problems: ValidationProblem[] = []
  if (typeof assertion.path === 'string' && Object.hasOwn(assertion, 'value')) {
    problems.push({ message: "'path' and 'value' exclude each other: an assertion looks at one thing" })
  }
  if (typeof assertion.path === 'string' && assertion.path.startsWith('$')) {
    problems.push({
      path: 'path',
      message: `'${assertion.path}' is the v1 spelling`,
      hint: `write the path into the step's result: 'body${assertion.path.slice(1)}' for an HTTP body`
    })
  }
  return problems
}

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

const VOCABULARY: Record<string, Check> = {
  /* Equality — structural, so two objects that say the same thing are equal
     however their keys happen to be ordered. */
  equals: {
    phrase: (i) => `to equal ${show(i.expected)}`,
    holds: (s, i) => deepEqual(s.value, i.expected)
  },
  not_equals: {
    phrase: (i) => `not to equal ${show(i.expected)}`,
    holds: (s, i) => !deepEqual(s.value, i.expected)
  },

  /* Order. Numbers compare as numbers; everything else compares the way the
     language does, which is what makes ISO dates and version-less strings
     work without a second vocabulary for them. */
  greater_than: {
    phrase: (i) => `to be greater than ${show(i.expected)}`,
    holds: (s, i) => ordered(s.value, i.expected, (a, b) => a > b)
  },
  at_least: {
    phrase: (i) => `to be at least ${show(i.expected)}`,
    holds: (s, i) => ordered(s.value, i.expected, (a, b) => a >= b)
  },
  less_than: {
    phrase: (i) => `to be less than ${show(i.expected)}`,
    holds: (s, i) => ordered(s.value, i.expected, (a, b) => a < b)
  },
  at_most: {
    phrase: (i) => `to be at most ${show(i.expected)}`,
    holds: (s, i) => ordered(s.value, i.expected, (a, b) => a <= b)
  },

  /* Membership, from both sides. Python's `in` is one word because the
     direction is obvious at the call site; written down in YAML it is not, so
     it is two words here. */
  contains: {
    phrase: (i) => `to contain ${show(i.expected)}`,
    holds: (s, i) => within(i.expected, s.value)
  },
  not_contains: {
    phrase: (i) => `not to contain ${show(i.expected)}`,
    holds: (s, i) => !within(i.expected, s.value)
  },
  one_of: {
    phrase: (i) => `to be one of ${show(i.expected)}`,
    holds: (s, i) => Array.isArray(i.expected) && i.expected.some((c) => deepEqual(s.value, c)),
    takes: { expected: { type: 'array' } }
  },
  not_one_of: {
    phrase: (i) => `not to be one of ${show(i.expected)}`,
    holds: (s, i) => Array.isArray(i.expected) && !i.expected.some((c) => deepEqual(s.value, c)),
    takes: { expected: { type: 'array' } }
  },

  /* Text. */
  matches: {
    phrase: (i) => `to match /${String(i.expected)}/${String(i.flags ?? '')}`,
    holds: (s, i) => typeof s.value === 'string' && new RegExp(String(i.expected), String(i.flags ?? '')).test(s.value),
    takes: { expected: { type: 'string' }, flags: { type: 'string' } }
  },
  starts_with: {
    phrase: (i) => `to start with ${show(i.expected)}`,
    holds: (s, i) => typeof s.value === 'string' && s.value.startsWith(String(i.expected)),
    takes: { expected: { type: 'string' } }
  },
  ends_with: {
    phrase: (i) => `to end with ${show(i.expected)}`,
    holds: (s, i) => typeof s.value === 'string' && s.value.endsWith(String(i.expected)),
    takes: { expected: { type: 'string' } }
  },

  /* Presence. These are the checks that must be allowed to look at a path
     that resolved to nothing — that is the whole question they ask. */
  exists: {
    phrase: () => 'to exist',
    holds: (s) => s.value !== undefined && s.value !== null,
    needs: [],
    tolerantOfMissing: true
  },
  missing: {
    phrase: () => 'not to be there',
    holds: (s) => s.value === undefined || s.value === null,
    needs: [],
    tolerantOfMissing: true
  },
  empty: {
    phrase: () => 'to be empty',
    holds: (s) => sizeOf(s.value) === 0,
    needs: [],
    tolerantOfMissing: true
  },
  not_empty: {
    phrase: () => 'not to be empty',
    holds: (s) => (sizeOf(s.value) ?? 0) > 0,
    needs: [],
    tolerantOfMissing: true
  },

  /**
   * Size, and the one check that carries its own comparison.
   *
   * A length is derived from the subject rather than being the subject, so
   * `at_least` cannot reach it: `at_least: 3` on a list of items would be
   * comparing an array to a number. Bounds live here instead of adding a
   * second selector nobody would find.
   */
  length: {
    phrase: (i) =>
      i.expected !== undefined
        ? `to have length ${String(i.expected)}`
        : `to have length ${[
            i.at_least !== undefined ? `at least ${String(i.at_least)}` : '',
            i.at_most !== undefined ? `at most ${String(i.at_most)}` : ''
          ].filter(Boolean).join(' and ')}`,
    holds: (s, i) => {
      const size = sizeOf(s.value)
      if (size === undefined) return false
      if (i.expected !== undefined) return size === Number(i.expected)
      if (i.at_least !== undefined && size < Number(i.at_least)) return false
      if (i.at_most !== undefined && size > Number(i.at_most)) return false
      return i.at_least !== undefined || i.at_most !== undefined
    },
    needs: [],
    takes: { expected: { type: 'number' }, at_least: { type: 'number' }, at_most: { type: 'number' } }
  },

  /* Shape, for the cases a schema file would be too much ceremony for. */
  is_type: {
    phrase: (i) => `to be a ${String(i.expected)}`,
    holds: (s, i) => typeName(s.value) === String(i.expected) ||
      (String(i.expected) === 'number' && typeName(s.value) === 'integer'),
    takes: { expected: { type: 'string' } },
    tolerantOfMissing: true
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

function define(ctx: PluginContext, name: string, check: Check): void {
  const needs = check.needs ?? ['expected']
  ctx.defineAssertion(name, {
    schema: {
      type: 'object',
      properties: { ...SELECTOR, expected: {}, ...(check.takes ?? {}) },
      ...(needs.length ? { required: needs } : {}),
      additionalProperties: false
    },
    validate(assertion) {
      const problems = checkSelector(assertion)
      if (name === 'length' && ['expected', 'at_least', 'at_most'].every((k) => assertion[k] === undefined)) {
        problems.push({ message: "'length' needs one of 'expected', 'at_least' or 'at_most'" })
      }
      if (name === 'matches' && typeof assertion.expected === 'string') {
        try {
          new RegExp(assertion.expected, typeof assertion.flags === 'string' ? assertion.flags : '')
        } catch (err) {
          problems.push({
            path: 'expected',
            message: `not a regular expression: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      }
      return problems
    },
    evaluate(assertCtx, input) {
      const subject = subjectOf(assertCtx, input)

      // A path that led nowhere is reported as that, rather than as a
      // comparison against `undefined`. "expected body.total to be at least
      // 100, got undefined" reads like a wrong number; the field is missing.
      if (!subject.found && !check.tolerantOfMissing) {
        return {
          passed: false,
          message: `${subject.label} is not there`,
          expected: input.expected,
          actual: undefined
        }
      }

      const passed = check.holds(subject, input)
      return {
        passed,
        message: passed
          ? `${subject.label} is ${show(subject.value)}`
          : `expected ${subject.label} ${check.phrase(input)}, got ${show(subject.value)}`,
        expected: input.expected,
        actual: subject.value
      }
    }
  })
}

/**
 * JSON Schema, by a real implementation rather than ours.
 *
 * A hand-written subset is the tempting version and the dangerous one: a
 * schema generated from OpenAPI arrives with `oneOf`, `$ref` and
 * `patternProperties`, and a validator that quietly ignores the keywords it
 * does not know reports a pass it never checked. A gate that lies is worse
 * than no gate. JSON Schema is a standard with a canonical implementation, so
 * this is exactly the depth that is not ours to write.
 */
function defineSchemaCheck(ctx: PluginContext): void {
  const root = ctx.host.root
  const dir = ctx.config<AssertConfig>().schemasDir ?? 'schemas'
  // ajv-formats ships as CommonJS, so the imported binding is the module's
  // own export rather than a namespace with one inside it.
  const addFormats = formats as unknown as (ajv: Ajv) => Ajv
  const ajv = addFormats(new Ajv({ allErrors: true, strict: false }))
  const compiled = new Map<string, ValidateFunction | string>()

  const locate = (ref: string) => (isAbsolute(ref) ? ref : ref.includes('/') && ref.startsWith('.')
    ? join(root, ref)
    : join(root, dir, ref))

  /** Compiled once and kept: the same schema is asserted on in fifty tests. */
  const load = (ref: string): ValidateFunction | string => {
    const file = locate(ref)
    const known = compiled.get(file)
    if (known !== undefined) return known

    let entry: ValidateFunction | string
    try {
      entry = ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object)
    } catch (err) {
      entry = err instanceof Error ? err.message : String(err)
    }
    compiled.set(file, entry)
    return entry
  }

  ctx.defineAssertion('schema', {
    schema: {
      type: 'object',
      properties: { ...SELECTOR, ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false
    },
    validate(assertion) {
      const problems = checkSelector(assertion)
      const ref = String(assertion.ref)
      const file = locate(ref)
      if (!existsSync(file)) return [...problems, { path: 'ref', message: `no such schema: ${file}` }]

      // Compiled here, not at the first assertion: a schema with a typo in it
      // is a broken test, and a broken test should be found in milliseconds.
      const entry = load(ref)
      if (typeof entry === 'string') problems.push({ path: 'ref', message: `${ref} is not a valid schema: ${entry}` })
      return problems
    },
    evaluate(assertCtx, input) {
      const subject = subjectOf(assertCtx, input)
      const validate = load(String(input.ref))
      if (typeof validate === 'string') {
        return { passed: false, message: `${String(input.ref)} is not a valid schema: ${validate}` }
      }
      const passed = validate(subject.value)
      return {
        passed,
        message: passed
          ? `${subject.label} matches ${String(input.ref)}`
          : `${subject.label} does not match ${String(input.ref)}: ${explain(validate)}`,
        expected: input.ref,
        actual: subject.value
      }
    }
  })
}

function explain(validate: ValidateFunction): string {
  const errors = (validate.errors ?? []).slice(0, 3)
  const said = errors.map((e) => `${e.instancePath || 'the value'} ${e.message ?? 'is wrong'}`).join('; ')
  const more = (validate.errors?.length ?? 0) - errors.length
  return more > 0 ? `${said} (and ${more} more)` : said || 'no detail'
}

/**
 * The two names that used to live in `plugin-http`.
 *
 * Kept working so a suite written against the old plugin still runs, and kept
 * out of the vocabulary above so nobody learns them fresh. They also do the
 * one thing the general selector will not: assume the subject is a response,
 * which is exactly why they had to move.
 */
function defineBridges(ctx: PluginContext): void {
  const deprecated = (name: string, instead: string, of: (last: unknown, input: Record<string, unknown>) => unknown) => {
    ctx.defineAssertion(name, {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, expected: {} },
        required: ['expected'],
        additionalProperties: false
      },
      evaluate(assertCtx, input) {
        const actual = of(assertCtx.last, input)
        const passed = name === 'jsonpath' ? deepEqual(actual, input.expected) : within(input.expected, actual)
        return {
          passed,
          message: passed
            ? `${name} holds (deprecated: write ${instead})`
            : `expected ${show(input.expected)}, got ${show(actual)} — deprecated, write ${instead}`,
          expected: input.expected,
          actual
        }
      }
    })
  }

  deprecated('jsonpath', "'equals' with 'path: body.…'", (last, input) =>
    readPath((last as Record<string, unknown> | undefined)?.body, String(input.path ?? '')))
  deprecated('body_contains', "'contains' with 'path: text'", (last) =>
    (last as Record<string, unknown> | undefined)?.text)
}

/* ------------------------------------------------------------------ */
/* The small parts every check is built from                           */
/* ------------------------------------------------------------------ */

/** Structural equality, so key order is not a difference. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((k) => Object.hasOwn(right, k) && deepEqual(left[k], right[k]))
}

/** `needle in haystack`, over the three things that can hold something. */
function within(needle: unknown, haystack: unknown): boolean {
  if (typeof haystack === 'string') return haystack.includes(String(needle))
  if (Array.isArray(haystack)) return haystack.some((item) => deepEqual(item, needle))
  if (haystack && typeof haystack === 'object') return Object.hasOwn(haystack, String(needle))
  return false
}

function ordered(actual: unknown, expected: unknown, by: (a: never, b: never) => boolean): boolean {
  const left = typeof actual === 'string' && actual !== '' && !Number.isNaN(Number(actual)) && typeof expected === 'number'
    ? Number(actual)
    : actual
  if (left === null || left === undefined || expected === null || expected === undefined) return false
  if (typeof left !== typeof expected) return false
  return by(left as never, expected as never)
}

/** How many things it holds, or undefined for something that holds none. */
function sizeOf(value: unknown): number | undefined {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string' || Array.isArray(value)) return value.length
  if (typeof value === 'object') return Object.keys(value).length
  return undefined
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/** Enough of a value to recognise it in a message, and no more. */
function show(value: unknown): string {
  if (value === undefined) return 'nothing'
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

export type { AssertOutcome }
