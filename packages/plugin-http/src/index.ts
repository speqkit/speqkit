import { definePlugin, type AssertOutcome } from '@speqkit/plugin-api'

interface HttpConfig {
  baseUrl?: string
  headers?: Record<string, string>
}

/**
 * The batteries-included plugin: an HTTP step and the smoke checks most teams
 * need on day one. It is an ordinary plugin — the kernel has no idea what
 * HTTP is, which is the whole test of the architecture.
 */
export default definePlugin({
  name: '@speqkit/plugin-http',
  configSchema: {
    type: 'object',
    properties: { baseUrl: { type: 'string' }, headers: { type: 'object' } }
  },

  setup(ctx) {
    ctx.defineStepType('http', {
      schema: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object' },
          body: {},
          query: { type: 'object' }
        },
        required: ['url'],
        additionalProperties: false
      },

      async execute(exec, input) {
        const config = exec.config<HttpConfig>()
        const method = String(input.method ?? 'GET').toUpperCase()
        const url = buildUrl(config.baseUrl, String(input.url), input.query as Record<string, unknown>)

        const headers: Record<string, string> = {
          ...(config.headers ?? {}),
          ...((input.headers as Record<string, string>) ?? {})
        }
        let payload: string | undefined
        if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
          payload = typeof input.body === 'string' ? input.body : JSON.stringify(input.body)
          headers['content-type'] ??= 'application/json'
        }

        const startedAt = Date.now()
        const response = await fetch(url, { method, headers, body: payload, signal: exec.signal })
        const text = await response.text()

        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: parseBody(text, response.headers.get('content-type')),
          text,
          url,
          durationMs: Date.now() - startedAt
        }
      }
    })

    ctx.defineAssertion('status', {
      schema: { type: 'object', properties: { expected: {} }, required: ['expected'] },
      evaluate(assert, input) {
        const actual = assert.last?.status
        return outcome(
          actual === input.expected,
          `expected status ${String(input.expected)}, got ${String(actual)}`,
          `status is ${String(actual)}`,
          input.expected,
          actual
        )
      }
    })

    ctx.defineAssertion('jsonpath', {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, expected: {} },
        required: ['path', 'expected'],
        additionalProperties: false
      },
      evaluate(assert, input) {
        const actual = readPath(assert.last?.body, String(input.path))
        const equal = JSON.stringify(actual) === JSON.stringify(input.expected)
        return outcome(
          equal,
          `${input.path}: expected ${JSON.stringify(input.expected)}, got ${JSON.stringify(actual)}`,
          `${input.path} is ${JSON.stringify(actual)}`,
          input.expected,
          actual
        )
      }
    })

    ctx.defineAssertion('body_contains', {
      schema: { type: 'object', properties: { expected: { type: 'string' } }, required: ['expected'] },
      evaluate(assert, input) {
        const text = String(assert.last?.text ?? '')
        const needle = String(input.expected)
        return outcome(
          text.includes(needle),
          `body does not contain ${JSON.stringify(needle)}`,
          `body contains ${JSON.stringify(needle)}`,
          needle,
          text.slice(0, 200)
        )
      }
    })

    ctx.defineAssertion('duration_under', {
      schema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
      evaluate(assert, input) {
        const actual = Number(assert.last?.durationMs ?? 0)
        const limit = Number(input.ms)
        return outcome(actual < limit, `took ${actual}ms, budget ${limit}ms`, `took ${actual}ms`, limit, actual)
      }
    })

    ctx.defineValueProvider('env', {
      prefix: 'env',
      resolve: (key) => process.env[key]
    })
  }
})

function outcome(
  passed: boolean, whenFailed: string, whenPassed: string, expected?: unknown, actual?: unknown
): AssertOutcome {
  return { passed, message: passed ? whenPassed : whenFailed, expected, actual }
}

function buildUrl(baseUrl: string | undefined, path: string, query?: Record<string, unknown>): string {
  const absolute = /^https?:\/\//i.test(path)
  const base = absolute ? path : `${(baseUrl ?? '').replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
  if (!query || Object.keys(query).length === 0) return base
  const url = new URL(base)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  return url.toString()
}

function parseBody(text: string, contentType: string | null): unknown {
  if (contentType?.includes('json')) {
    try { return JSON.parse(text) } catch { return text }
  }
  try { return JSON.parse(text) } catch { return text }
}

function readPath(value: unknown, path: string): unknown {
  let current = value
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
