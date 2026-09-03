import { createHash, randomBytes } from 'node:crypto'
import { definePlugin } from '@speqkit/plugin-api'

/**
 * Where values come from.
 *
 * Three providers and no step types: this plugin never does anything, it only
 * answers. `${gen:uuid}` is a tenant slug nobody else will use, `${env:TOKEN}`
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
      seed: { type: 'string' },
      emailDomain: { type: 'string' },
      vars: { type: 'object' },
      generators: { type: 'object' }
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
    let test = ''

    if (!config.seed && !process.env.SPEQ_SEED) {
      ctx.onEvent((event) => {
        if (event.type === 'run.started') seed = event.runId
      })
    }
    ctx.defineHook('test:before', (payload) => { test = payload.test ?? '' })
    ctx.defineHook('test:after', () => { test = '' })

    // Each `${gen:…}` in a test gets its own value, and gets the same value
    // again on a re-run with the same seed. The counter is what separates the
    // second `${gen:uuid}` of a test from the first; keying it by test as
    // well is what lets one failing test be re-run alone and still see the
    // data it saw inside the full suite.
    const counters = new Map<string, number>()

    ctx.defineValueProvider('gen', {
      summary: 'a generated value — uuid, string, int, email, date, or one your speq.yaml names',
      prefix: 'gen',
      resolve(key) {
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
  }
})

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
