import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { definePlugin, type AssertOutcome, type ValidationProblem } from '@speqkit/plugin-api'

interface RetryConfig {
  /** Total attempts, including the first. 1 turns retrying off. */
  attempts?: number
  delayMs?: number
  backoff?: 'fixed' | 'exponential'
  /** Retry when the request never got an answer at all. */
  network?: boolean
  /** Response codes worth asking again about. */
  status?: number[]
  /** Methods that may be repeated. */
  methods?: string[]
}

interface HttpConfig {
  baseUrl?: string
  headers?: Record<string, string>
  retry?: RetryConfig
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
    properties: {
      baseUrl: { type: 'string' },
      headers: { type: 'object' },
      retry: { type: 'object' }
    }
  },

  setup(ctx) {
    const root = ctx.host.root

    ctx.defineStepType('http', {
      schema: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object' },
          body: {},
          multipart: { type: 'object' },
          query: { type: 'object' },
          retry: { type: 'object' }
        },
        required: ['url'],
        additionalProperties: false
      },

      /**
       * The check the corpus this plugin was written against paid for.
       *
       * Under speq 1.x, `multipart`, `formData`, `form`, `files`, `bodyFile`
       * and `bodyRaw` were all accepted and all silently ignored: the request
       * went out with an empty body and the test reported **passed**. Three
       * upload paths went untested for months behind a green tick. A closed
       * schema is what makes that impossible — an unknown key is refused
       * before the run — and the checks below are the same idea one level
       * deeper: a part naming a file that is not on disk is a mistake worth
       * finding in milliseconds, not in the middle of a suite.
       */
      validate(step, validation) {
        const problems: (string | ValidationProblem)[] = []
        if (step.body !== undefined && step.multipart !== undefined) {
          problems.push({
            path: 'multipart',
            message: "'body' and 'multipart' exclude each other",
            hint: 'a request has one body; multipart is how it is encoded'
          })
        }

        for (const [name, part] of Object.entries(partsOf(step.multipart))) {
          // Only a part that names a file has a file to find. One built from
          // `content:` is a part the step produced, and there is nothing on
          // disk to look for.
          if (!isFilePart(part) || part.file === undefined) continue
          const path = locate(String(part.file), root)
          if (!existsSync(path)) {
            problems.push({ path: `multipart.${name}.file`, message: `no such file: ${path}` })
          }
        }

        void validation
        return problems
      },

      async execute(exec, input) {
        const config = exec.config<HttpConfig>()
        const method = String(input.method ?? 'GET').toUpperCase()
        const url = buildUrl(config.baseUrl, String(input.url), input.query as Record<string, unknown>)

        const headers: Record<string, string> = {
          ...(config.headers ?? {}),
          ...((input.headers as Record<string, string>) ?? {})
        }

        let payload: string | FormData | undefined
        if (input.multipart !== undefined) {
          payload = buildForm(partsOf(input.multipart), root)
          // Deliberately deleted rather than set. `fetch` writes the header
          // itself, and it has to: the boundary is generated with the body,
          // and a hand-written content-type would name a boundary that is not
          // in the request — which a server reports as a malformed body,
          // several layers away from the line that caused it.
          delete headers['content-type']
          delete headers['Content-Type']
        } else if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
          payload = typeof input.body === 'string' ? input.body : JSON.stringify(input.body)
          headers['content-type'] ??= 'application/json'
        }

        const policy = retryPolicy(config.retry, input.retry as RetryConfig | undefined)
        const startedAt = Date.now()
        let attempts = 0
        let response: Response

        for (;;) {
          attempts += 1
          try {
            response = await fetch(url, { method, headers, body: payload, signal: exec.signal })
          } catch (err) {
            if (exec.signal.aborted || !worthRepeating(policy, method, undefined, attempts)) {
              throw requestFailed(err, method, url, attempts)
            }
            await pause(policy, attempts, exec.signal)
            continue
          }
          if (!worthRepeating(policy, method, response.status, attempts)) break
          await pause(policy, attempts, exec.signal)
        }

        const text = await response.text()

        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: parseBody(text, response.headers.get('content-type')),
          text,
          url,
          attempts,
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

/* ------------------------------------------------------------------ */
/* Multipart                                                           */
/* ------------------------------------------------------------------ */

interface FilePart {
  file?: string
  content?: string
  filename?: string
  contentType?: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain'
}

/**
 * `TypeError: fetch failed` names nothing a person can act on.
 *
 * That is the whole message undici throws for a refused connection, an
 * unresolvable host, a self-signed certificate and a closed socket alike — and
 * it was going out of here unchanged, so a suite pointed at the wrong port
 * reported four words and no port. What the reader needs is on `err.cause`,
 * one or two links down: the sentence, and the errno that says which of the
 * four it was. The original is kept as the cause of this one, so nothing is
 * lost for whoever wants the stack.
 */
function requestFailed(err: unknown, method: string, url: string, attempts: number): Error {
  const tried = attempts > 1 ? ` after ${attempts} attempts` : ''
  return new Error(`${method} ${url} failed${tried}: ${reasonOf(err)}`, { cause: err })
}

/** The chain under a wrapper, as one sentence, deepest cause last. */
function reasonOf(err: unknown): string {
  const said: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err

  while (current instanceof Error && !seen.has(current) && said.length < 3) {
    seen.add(current)
    // 'fetch failed' is the wrapper itself. Saying it adds nothing to the
    // sentence and pushes the one that matters off the end.
    if (current.message && current.message !== 'fetch failed') {
      const code = (current as NodeJS.ErrnoException).code
      said.push(code && !current.message.includes(code) ? `${current.message} (${code})` : current.message)
    }
    // An AggregateError is what a host with several addresses fails as: one
    // error per address tried, all of them the same thing.
    current = current instanceof AggregateError && current.errors.length > 0
      ? current.errors[0]
      : current.cause
  }

  return said.join(': ') || 'the request did not complete, and nothing said why'
}

function partsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isFilePart(part: unknown): part is FilePart {
  return !!part && typeof part === 'object' && !Array.isArray(part)
}

/**
 * A part is either a plain field or a file, and the difference is whether it
 * is written as a scalar or as a block. `FormData` and `Blob` are built into
 * Node, so this is short — the reason it did not exist was never the code.
 */
function buildForm(parts: Record<string, unknown>, root: string): FormData {
  const form = new FormData()
  for (const [name, part] of Object.entries(parts)) {
    if (!isFilePart(part)) {
      form.append(name, String(part))
      continue
    }

    const bytes = part.file !== undefined
      ? new Uint8Array(readFileSync(locate(part.file, root)))
      : new TextEncoder().encode(String(part.content ?? ''))
    const filename = part.filename ?? (part.file ? basename(part.file) : name)
    const type = part.contentType ?? CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream'
    form.append(name, new Blob([bytes], { type }), filename)
  }
  return form
}

/** Relative to the project root, the way every other path in a suite is. */
function locate(path: string, root: string): string {
  return isAbsolute(path) ? path : join(root, path)
}

/* ------------------------------------------------------------------ */
/* Retrying                                                            */
/* ------------------------------------------------------------------ */

/**
 * Retrying is for the gap between "the container is up" and "the API answers",
 * and for nothing else.
 *
 * Two defaults are worth the words.
 *
 * **429 is not in the list, and adding it should be a decision.** A rate
 * limiter is behaviour a suite tests, and a policy that quietly retries 429
 * makes the test that proves the limiter works unfalsifiable — it passes
 * whether the limiter exists or not, which is worse than not having the test.
 *
 * **Only idempotent methods are repeated.** A 502 means a gateway answered;
 * it does not mean the origin never saw the request. Repeating a POST that
 * timed out on the way back creates the row twice, and the suite reports a
 * duplicate-key failure somewhere else entirely. Naming a method in `methods`
 * is how a project that knows its endpoint is idempotent opts in.
 */
const RETRY_DEFAULTS = {
  attempts: 1,
  delayMs: 300,
  backoff: 'exponential' as const,
  network: true,
  status: [502, 503, 504],
  methods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']
}

type Policy = Required<RetryConfig>

function retryPolicy(fromConfig: RetryConfig | undefined, fromStep: RetryConfig | undefined): Policy {
  return { ...RETRY_DEFAULTS, ...(fromConfig ?? {}), ...(fromStep ?? {}) }
}

function worthRepeating(policy: Policy, method: string, status: number | undefined, attempts: number): boolean {
  if (attempts >= Math.max(1, policy.attempts)) return false
  if (!policy.methods.some((m) => m.toUpperCase() === method)) return false
  return status === undefined ? policy.network : policy.status.includes(status)
}

function pause(policy: Policy, attempts: number, signal: AbortSignal): Promise<void> {
  const wait = policy.backoff === 'fixed'
    ? policy.delayMs
    : policy.delayMs * 2 ** (attempts - 1)
  return new Promise((resolve, reject) => {
    // Under the step's own timeout, so a policy of five attempts against a
    // service that is never coming back is still the step taking too long
    // rather than a run that stops reporting.
    const timer = setTimeout(done, wait)
    function done(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------ */

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
