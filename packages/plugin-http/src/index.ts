import { definePlugin, type AssertOutcome } from '@speqkit/plugin-api'

interface HttpConfig {
  baseUrl?: string
  headers?: Record<string, string>
}

/**
 * The protocol, and only the protocol.
 *
 * What is left here after `jsonpath` and `body_contains` left for
 * `@speqkit/plugin-assert` is the two checks that are genuinely about HTTP:
 * the status line and the time on the wire. Everything else was checking a
 * *value*, and a value does not care that it arrived over HTTP — its twin is
 * needed by a SQL row and the body of a Kafka message, and every author would
 * have written their own if the vocabulary lived here.
 *
 * The kernel has no idea what HTTP is, which is the whole test of the
 * architecture.
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

    ctx.defineAssertion('duration_under', {
      schema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
      evaluate(assert, input) {
        const actual = Number(assert.last?.durationMs ?? 0)
        const limit = Number(input.ms)
        return outcome(actual < limit, `took ${actual}ms, budget ${limit}ms`, `took ${actual}ms`, limit, actual)
      }
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

