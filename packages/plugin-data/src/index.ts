import { createHash, randomBytes } from 'node:crypto'
import {
  definePlugin, type AssertOutcome, type AssertionDef, type PluginContext
} from '@speqkit/plugin-api'

/**
 * Where values come from.
 *
 * Three providers and one step that acts on nothing: this plugin never
 * touches the system under test, it only answers and binds. `${gen:uuid}` is a tenant slug nobody else will use, `${env:TOKEN}`
 * is what CI put in the environment, `${vars:adminApi}` is the route prefix
 * this project writes in every URL.
 *
 * Generated values are derived from a seed rather than drawn from the system
 * random source. A suite that fails on the third of sixty tests is worth
 * re-running with the same data, and "the same data" has to mean something
 * for that to be possible.
 */

interface GeneratorSpec {
  type: 'uuid' | 'string' | 'int' | 'email' | 'date'
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
  from?: string
  to?: string
}

interface DataConfig {
  /**
   * Fixes the values every `${gen:…}` produces. Defaults to the run id, which
   * is already printed by every reporter and already names the report
   * directory — so replaying a run means copying a string that is on screen.
   */
  seed?: string
  /** The domain `${gen:email}` builds addresses under. */
  emailDomain?: string
  /** Project values, addressable as `${vars:name}` and tuned per environment. */
  vars?: Record<string, unknown>
  /** Generators with their parameters settled once, addressable by name. */
  generators?: Record<string, GeneratorSpec>
}

const BUILTIN: Record<string, GeneratorSpec> = {
  uuid: { type: 'uuid' },
  string: { type: 'string' },
  int: { type: 'int' },
  email: { type: 'email' },
  date: { type: 'date' }
}

const DEFAULTS = {
  length: 16,
  min: 0,
  max: 1_000_000,
  windowDays: 365,
  emailDomain: 'example.com'
} as const

/** Lowercase alphanumerics only — see `string` in the README for why. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export default definePlugin({
  name: '@speqkit/plugin-data',
  docs: {
    summary: 'values a test needs but does not care about: generated data, environment, project settings',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-data#readme',
    examples: [
      {
        title: 'a value the steps below share',
        summary:
          'A given that comes out of a step cannot go in `variables:` — those are resolved before ' +
          'anything runs. This is where it goes, in the order somebody reads.',
        for: ['set'],
        code: [
          'steps:',
          '  - id: created',
          '    type: http',
          '    method: POST',
          '    url: /orders',
          '  - id: order',
          '    type: set',
          '    value: ${created.body.id}',
          '  - type: http',
          '    method: GET',
          '    url: /orders/${order.value}'
        ].join('\n')
      },
      {
        title: 'which one of these — said by what is in it',
        summary:
          'A row number points at the right element until somebody adds a row. ' +
          'The clauses are the ordinary assertion words, read against each element.',
        for: ['pick'],
        code: [
          'steps:',
          '  - id: snap',
          '    type: http',
          '    method: GET',
          '    url: /public/menu/demo/main',
          '  - id: item',
          '    type: pick',
          '    from: ${snap.body.categories[*].items[*]}',
          '    where:',
          '      - type: contains',
          '        path: optionGroups[*].required',
          '        expected: true',
          '  - type: http',
          '    method: GET',
          '    url: /items/${item.value.id}'
        ].join('\n')
      },
      {
        title: 'what the total should be, worked out rather than written down',
        summary:
          'A constant here would check that the server adds up the way it did last time. ' +
          'Nested mappings rather than an expression, so the shape is checked before the run.',
        for: ['calc'],
        code: [
          'steps:',
          '  - id: expected',
          '    type: calc',
          '    multiply:',
          '      - add:',
          '          - ${item.value.priceMinor}',
          '          - ${option.value.priceDeltaMinor}',
          '      - 2',
          '  - type: http',
          '    method: POST',
          '    url: /public/orders',
          '    assert:',
          '      - type: equals',
          '        path: body.totalMinor',
          '        expected: ${expected.value}'
        ].join('\n')
      },
      {
        title: 'data a test does not want to invent',
        summary:
          'Seeded from the run id, so re-running one test replays the values it ran with. ' +
          'The seed is printed by every reporter and names the report directory.',
        for: ['gen'],
        code: [
          'variables:',
          '  orderId: ${gen:uuid}',
          '  buyer: ${gen:email}',
          '  # derived: givens resolve in order, so this sees the one above',
          '  label: order-${orderId}'
        ].join('\n')
      },
      {
        title: 'the environment, and what to do when it is not set',
        for: ['env'],
        code: [
          'headers:',
          '  authorization: Bearer ${env:API_TOKEN}',
          '  x-region: ${env:REGION:-eu-west-1}'
        ].join('\n')
      },
      {
        title: 'a project value one environment overrides',
        summary: 'Declared under `data.vars` in speq.yaml and again in `environments/staging.yaml`.',
        for: ['vars'],
        code: [
          '# speq.yaml',
          'data:',
          '  vars:',
          '    currency: EUR',
          '',
          '# in a suite',
          'url: ${base}/prices?currency=${vars:currency}'
        ].join('\n')
      }
    ]
  },
  configSchema: {
    type: 'object',
    properties: {
      seed: { type: 'string', description: 'fixes every `${gen:…}` value; the run id by default, so a run replays from the string that names its report' },
      emailDomain: { type: 'string', description: 'what `${gen:email}` builds addresses under; example.com by default' },
      vars: {
        type: 'object',
        description: 'project values, addressable as `${vars:name}` and layered per environment',
        additionalProperties: true
      },
      generators: {
        type: 'object',
        description: 'named generators with their parameters settled once, addressable as `${gen:name}`',
        additionalProperties: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['uuid', 'string', 'int', 'email', 'date'], description: 'which generator this is built on' },
            minLength: { type: 'integer', minimum: 1, description: 'for `string`: the shortest value; 16 by default' },
            maxLength: { type: 'integer', minimum: 1, description: 'for `string`: the longest value; the minimum by default' },
            min: { type: 'integer', description: 'for `int`: the smallest value; 0 by default' },
            max: { type: 'integer', description: 'for `int`: the largest value; 1000000 by default' },
            from: { type: 'string', description: 'for `date`: the earliest, as an ISO date; a year ago by default' },
            to: { type: 'string', description: 'for `date`: the latest, as an ISO date; today by default' }
          },
          required: ['type'],
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const config = ctx.config<DataConfig>()
    const generators = { ...BUILTIN, ...(config.generators ?? {}) }
    for (const [name, spec] of Object.entries(config.generators ?? {})) check(name, spec)

    const vars = config.vars ?? {}
    const emailDomain = config.emailDomain ?? DEFAULTS.emailDomain

    // A fallback for the case where nothing announced a run — a plugin test,
    // a library caller stepping the executor by hand. Replaced by the run id
    // the moment a real run starts.
    let seed = config.seed ?? process.env.SPEQ_SEED ?? randomBytes(16).toString('hex')

    if (!config.seed && !process.env.SPEQ_SEED) {
      ctx.onEvent((event) => {
        if (event.type === 'run.started') seed = event.runId
      })
    }

    // Each `${gen:…}` in a test gets its own value, and gets the same value
    // again on a re-run with the same seed. The counter is what separates the
    // second `${gen:uuid}` of a test from the first; keying it by test as
    // well is what lets one failing test be re-run alone and still see the
    // data it saw inside the full suite. Which test that is comes from the
    // kernel, per call — see `resolve` below.
    const counters = new Map<string, number>()

    ctx.defineValueProvider('gen', {
      summary: 'a generated value — uuid, string, int, email, date, or one your speq.yaml names',
      prefix: 'gen',
      resolve(key, where) {
        // Which test is asking, said by the kernel at the moment it asks.
        // This used to be a variable set by a `test:before` hook — the last
        // test to start — and under `--workers 4` that is whichever suite got
        // there first: a value generated for one test was keyed by another's
        // name, and two tests could be handed the same "unique" tenant. That
        // is the failure the seeding exists to prevent, and it was in the
        // seeding.
        const test = where?.test ?? where?.suite ?? ''
        const spec = generators[key]
        if (!spec) {
          const known = Object.keys(generators).sort().join(', ')
          throw new Error(
            `\${gen:${key}} names no generator; this project has: ${known}. ` +
              `Declare one under 'data.generators' in speq.yaml to give a generator its parameters.`
          )
        }
        const slot = `${test}\x00${key}`
        const nth = counters.get(slot) ?? 0
        counters.set(slot, nth + 1)
        return generate(spec, bytesFor(seed, test, key, nth), emailDomain)
      }
    })

    /**
     * Moved here from `plugin-http`, where it only ever lived because HTTP was
     * the first plugin to need a token out of CI. Reading the environment has
     * nothing to do with the protocol under test.
     */
    ctx.defineValueProvider('env', {
      summary: 'a process environment variable, with `:-` for a default when it is unset',
      prefix: 'env',
      resolve(key) {
        const split = key.indexOf(':-')
        const name = split < 0 ? key : key.slice(0, split)
        const found = process.env[name]
        if (found !== undefined) return found
        if (split >= 0) return key.slice(split + 2)
        throw new Error(
          `\${env:${name}} is not set. Export it, or write \${env:${name}:-default} to make it optional.`
        )
      }
    })

    ctx.defineValueProvider('vars', {
      summary: 'a project value from speq.yaml, which an environment layer may override',
      prefix: 'vars',
      resolve(key) {
        if (!(key in vars)) {
          const known = Object.keys(vars).sort().join(', ') || '(none)'
          throw new Error(`\${vars:${key}} is not declared; 'data.vars' has: ${known}`)
        }
        return vars[key]
      }
    })

    /**
     * The one step here, and it acts on nothing: it binds what the test
     * already wrote.
     *
     * Without it, a value used in four places has to be written out four
     * times or hidden in a `variables:` block at the top, away from the steps
     * that read it — and a value derived from a step's own result cannot go in
     * `variables:` at all, because those are resolved before anything runs.
     * `set` is where a derived given goes: after the step it comes from, in
     * the order somebody reads.
     *
     * It binds under the step's id like every other step, so it is
     * `${total.value}` and not `${total}`. That is one character worse and
     * one rule fewer: everything a step produces is addressed the same way.
     */
    ctx.defineStepType('set', {
      summary: 'binds a value under this step\'s id, addressable below as ${id.value}',
      schema: {
        type: 'object',
        properties: {
          value: { description: 'anything — a literal, or a ${…} the test has already bound' }
        },
        required: ['value'],
        additionalProperties: false
      },
      // Nothing is called, nothing is reached for: the kernel resolved the
      // input before this ran, and the whole of the step is handing it back.
      execute: (_exec, input) => ({ value: input.value })
    })

    definePick(ctx)
    defineCalc(ctx)
  }
})

/* ------------------------------------------------------------------ */
/* pick — which one of these                                           */
/* ------------------------------------------------------------------ */

/**
 * The element a test means, said by what is in it rather than by where it sits.
 *
 * The suite this was written for orders food, and it needs the menu item that
 * has a required option group with a paid option in it — because that is the
 * item whose total is worth checking. What it could write before was
 * `categories[0].items[0]`, which is not that item: it is a row number that
 * happens to point at it today, in a fixture that moves for reasons the test
 * knows nothing about. On the day somebody adds a category, the suite either
 * fails for no defect or, worse, quietly starts ordering a plain item and
 * checking a total that no longer exercises options at all.
 *
 * The clauses are the ordinary assertion vocabulary — `equals`,
 * `greater_than`, `exists`, and whatever a plugin somebody published has added
 * to it. There is no second list of comparison words here, and the reason is
 * that the second list is always the one missing `at_least`. See
 * `ExecContext.check`.
 */
function definePick(ctx: PluginContext): void {
  ctx.defineStepType('pick', {
    summary: 'the first element of a list that satisfies every clause, bound as ${id.value}',
    schema: {
      type: 'object',
      properties: {
        from: {
          description:
            'the list to search — usually a wildcard path, ${snap.body.categories[*].items[*]}'
        },
        where: {
          type: 'array',
          minItems: 1,
          description:
            'clauses every element has to satisfy, written the way an assert: block is; ' +
            "a clause's `path` reads into the element",
          items: {
            type: 'object',
            required: ['type'],
            properties: { type: { type: 'string', description: 'an assertion the loaded plugins provide' } }
          }
        }
      },
      required: ['from', 'where'],
      additionalProperties: false
    },
    async execute(exec, input) {
      const from = input.from
      if (!Array.isArray(from)) {
        throw new Error(
          `pick searches a list, and 'from' is ${describe(from)}. ` +
            'A wildcard path is what usually produces one: body.categories[*].items[*].'
        )
      }
      const where = input.where as AssertionDef[]

      // The closest miss, kept as the run goes: a `pick` that matches nothing
      // is almost always one clause too strict, and "nothing matched" on its
      // own leaves the author diffing four clauses against sixty elements by
      // hand. The element that failed fewest is the one they want to look at.
      let closest: { index: number; failed: (AssertOutcome & { type: string })[] } | undefined

      for (const [index, element] of from.entries()) {
        const outcomes = await exec.check(where, element)
        const failed = outcomes.filter((o) => !o.passed)
        if (failed.length === 0) return { value: element, index }
        if (!closest || failed.length < closest.failed.length) closest = { index, failed }
      }

      throw new Error(
        `no element of the list satisfies every clause; ${from.length} examined` +
          (closest
            ? `. The closest was #${closest.index}, and it ${closest.failed[0]!.message}`
            : '. The list is empty — the path that produced it may be the thing to look at')
      )
    }
  })
}

/* ------------------------------------------------------------------ */
/* calc — what the number should be                                    */
/* ------------------------------------------------------------------ */

/**
 * Arithmetic over values the test already read, and nothing else.
 *
 * The same suite has to say what an order should cost: the item's price plus
 * the option's delta, times the quantity. Its two other options were both bad
 * tests. A constant turns *the server adds up correctly* into *the server adds
 * up the way it did last time*, pinned to a fixture that will move. Reading
 * the total back off the response and comparing it to itself checks nothing at
 * all — and is the easier of the two to write by accident.
 *
 * Written as nested mappings rather than as `(a + b) * n`, which is longer to
 * read and is the point: an expression is a string the kernel would have to
 * parse and `speq validate` could not check past its syntax, and the moment
 * one exists it grows string functions, dates and a ternary. This is a closed
 * grammar of three words, checked against a schema before the run like every
 * other step input.
 *
 * There is no `divide`, and that is a decision rather than an omission. Money
 * here is integer minor units; a division that does not come out exactly is a
 * rounding rule, rounding rules belong to the server, and a test that invents
 * its own will agree with the server right up until the half-cent that matters.
 * A case that genuinely needs it can ask, with the case attached.
 */
function defineCalc(ctx: PluginContext): void {
  const operands = { type: 'array', minItems: 1, description: 'numbers, ${…} that resolve to them, or nested operations' } as const
  ctx.defineStepType('calc', {
    summary: 'a number worked out from values the test already has, bound as ${id.value}',
    schema: {
      type: 'object',
      properties: { add: operands, subtract: operands, multiply: operands },
      additionalProperties: false,
      oneOf: [{ required: ['add'] }, { required: ['subtract'] }, { required: ['multiply'] }]
    },
    // Nothing is reached for and nothing is called: the kernel resolved every
    // ${…} in the input, and what is left is addition.
    execute: (_exec, input) => ({ value: evaluate(input) })
  })
}

const OPERATIONS = ['add', 'subtract', 'multiply'] as const
type Operation = (typeof OPERATIONS)[number]

function evaluate(node: unknown): number {
  if (typeof node === 'number' && Number.isFinite(node)) return node
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const present = OPERATIONS.filter((op) => Object.hasOwn(node as object, op))
    const op = present[0]
    if (present.length === 1 && op !== undefined) return apply(op, (node as Record<string, unknown>)[op])
    throw new Error(
      present.length === 0
        ? `calc knows ${OPERATIONS.join(', ')}, and this operation is none of them: ${Object.keys(node as object).join(', ') || '(no keys)'}`
        : `an operation is one of ${OPERATIONS.join(', ')}, and this has ${present.length}: ${present.join(' and ')}`
    )
  }
  throw new Error(
    `calc works on numbers, and this operand is ${describe(node)}. ` +
      'A ${…} that reads a string from a response is the usual cause — the field may be quoted.'
  )
}

/**
 * An operand that is a list contributes its elements, one level deep, so a
 * wildcard path is a sum: `add: ["${order.body.lines[*].totalMinor}"]`. It is
 * the one place a list is not a mistake, and it is why `add` takes one operand
 * as happily as five.
 */
function apply(op: Operation, raw: unknown): number {
  const list = Array.isArray(raw) ? raw : [raw]
  const values = list.flatMap((item) => (Array.isArray(item) ? item : [item])).map(evaluate)

  if (values.length === 0) throw new Error(`'${op}' needs something to work on, and the list is empty`)
  if (op === 'subtract' && values.length !== 2) {
    throw new Error(`'subtract' takes exactly two operands — what to take from, then what to take — and has ${values.length}`)
  }
  switch (op) {
    case 'add': return values.reduce((a, b) => a + b, 0)
    case 'subtract': return values[0]! - values[1]!
    case 'multiply': return values.reduce((a, b) => a * b, 1)
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'not there'
  if (Array.isArray(value)) return `a list of ${value.length}`
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`
  return `a ${typeof value}`
}

/**
 * Bytes that depend on the seed, the test, the generator and how many times
 * this test has already asked for it — and on nothing else.
 *
 * Deriving rather than drawing from a stream is what makes a single test
 * reproducible on its own: running test 3 alone and running it inside the
 * whole suite ask for the same bytes, because neither the other tests nor the
 * order they ran in is part of the input.
 */
function bytesFor(seed: string, test: string, key: string, nth: number): Buffer {
  // NUL separates the parts because it is the one byte a test name, a
  // generator name and a run id cannot contain. Any printable separator would
  // let two different inputs join into the same string — a test called `a b`
  // and a test called `a` asking for generator `b` — and hand two tests the
  // same generated data with nothing on screen to explain it.
  return createHash('sha256').update(`${seed}\x00${test}\x00${key}\x00${nth}`).digest()
}

function generate(spec: GeneratorSpec, bytes: Buffer, emailDomain: string): string | number {
  switch (spec.type) {
    case 'uuid':
      return uuidFrom(bytes)
    case 'email':
      return `speq-${bytes.subarray(0, 8).toString('hex')}@${emailDomain}`
    case 'int':
      return spanned(bytes, spec.min ?? DEFAULTS.min, spec.max ?? DEFAULTS.max)
    case 'string': {
      const min = spec.minLength ?? DEFAULTS.length
      const length = spanned(bytes, min, spec.maxLength ?? min)
      let out = ''
      for (let i = 0; i < length; i++) out += ALPHABET[bytes[i % bytes.length]! % ALPHABET.length]
      return out
    }
    case 'date': {
      const day = 86_400_000
      const to = spec.to ? Date.parse(spec.to) : Date.now()
      const from = spec.from ? Date.parse(spec.from) : to - DEFAULTS.windowDays * day
      const at = spanned(bytes, Math.floor(from / day), Math.floor(to / day)) * day
      return new Date(at).toISOString().slice(0, 10)
    }
  }
}

/** A uuid v4 by layout — the bits that say "random" are set, the rest is the digest. */
function uuidFrom(bytes: Buffer): string {
  const b = Buffer.from(bytes.subarray(0, 16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** An integer in [min, max], read out of the digest. */
function spanned(bytes: Buffer, min: number, max: number): number {
  if (max <= min) return min
  // 48 bits against a span that is never remotely that large: the modulo bias
  // is far below anything a test could notice.
  const drawn = bytes.readUIntBE(0, 6)
  return min + (drawn % (max - min + 1))
}

/**
 * Config is checked when the plugin loads, not when a step asks.
 *
 * A generator with `min` above `max` is a typo in speq.yaml, and finding it
 * twenty minutes into a suite — from a step that cannot say which line of
 * config it came from — is the worst possible moment.
 */
function check(name: string, spec: GeneratorSpec): void {
  if (!spec || typeof spec !== 'object' || !(spec.type in BUILTIN)) {
    const known = Object.keys(BUILTIN).sort().join(', ')
    throw new Error(`data.generators.${name}: '${String(spec?.type)}' is not a generator type; available: ${known}`)
  }
  if (spec.type === 'int' && (spec.min ?? 0) > (spec.max ?? DEFAULTS.max)) {
    throw new Error(`data.generators.${name}: min ${spec.min} is above max ${spec.max}`)
  }
  if (spec.type === 'string') {
    const min = spec.minLength ?? DEFAULTS.length
    if (min < 1) throw new Error(`data.generators.${name}: minLength must be at least 1`)
    if ((spec.maxLength ?? min) < min) {
      throw new Error(`data.generators.${name}: maxLength ${spec.maxLength} is below minLength ${min}`)
    }
  }
  if (spec.type === 'date') {
    for (const bound of ['from', 'to'] as const) {
      const value = spec[bound]
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        throw new Error(`data.generators.${name}: ${bound} '${value}' is not a date`)
      }
    }
  }
}
