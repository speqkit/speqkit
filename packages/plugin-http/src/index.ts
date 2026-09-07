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
  /** Extra names to mask wherever they appear — beside the ones always masked. */
  redact?: string[]
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
/* ------------------------------------------------------------------ */
/* The shapes, written once and declared twice                        */
/* ------------------------------------------------------------------ */

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const WHOLE_TEMPLATE = /^\$\{[^}]+\}$/

/**
 * A schema with a `description` on every field, because the schema is what a
 * reader who is not a person gets: `speq capabilities` hands it over, an
 * editor completes from it, and a model writes the suite from it. A shape
 * with no words attached — `retry: { type: object }` — is an invitation to
 * invent the keys inside it, and `attemps: 3` under it was accepted without
 * a word for as long as the kernel read only the top level.
 */
const HEADERS_SCHEMA = {
  type: 'object',
  description: 'one header per key; a value that is not a string is sent as its text',
  additionalProperties: { type: ['string', 'number', 'boolean'] }
} as const

const RETRY_SCHEMA = {
  type: 'object',
  description:
    'asks again on a network error or a listed status; off unless `attempts` is above 1. ' +
    '429 is deliberately not in the default list, and only idempotent methods repeat unless `methods` says otherwise',
  properties: {
    attempts: { type: 'integer', minimum: 1, description: 'total tries, the first one included; 1 turns retrying off' },
    delayMs: { type: 'number', minimum: 0, description: 'the wait before the second try, in milliseconds; 300 by default' },
    backoff: { type: 'string', enum: ['fixed', 'exponential'], description: 'whether the wait doubles each time; exponential by default' },
    network: { type: 'boolean', description: 'retry when no answer came at all; true by default' },
    status: { type: 'array', items: { type: 'integer' }, description: 'response codes worth asking again about; 502, 503 and 504 by default' },
    methods: { type: 'array', items: { type: 'string' }, description: 'methods that may be repeated; GET, HEAD, OPTIONS, PUT and DELETE by default' }
  },
  additionalProperties: false
} as const

export default definePlugin({
  name: '@speqkit/plugin-http',
  docs: {
    summary: 'talks to an HTTP service, and records the exchange when it does not go well',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-http#readme',
    examples: [
      {
        title: 'a GET, and two checks on what came back',
        for: ['http', 'status'],
        code: [
          '- id: order',
          '  type: http',
          '  method: GET',
          '  url: ${base}/orders/${orderId}',
          '  assert:',
          '    - type: status',
          '      expected: 200',
          '    - type: equals',
          '      path: body.total',
          '      expected: 600'
        ].join('\n')
      },
      {
        title: 'a POST with a JSON body, kept for the next step',
        summary: "A step's `id` is how the steps below it reach its result.",
        for: ['http'],
        code: [
          '- id: created',
          '  type: http',
          '  method: POST',
          '  url: ${base}/refunds',
          '  headers:',
          '    authorization: Bearer ${env:API_TOKEN}',
          '  body:',
          '    orderId: ${orderId}',
          '    amount: 600',
          '  assert:',
          '    - type: status',
          '      expected: 201'
        ].join('\n')
      },
      {
        title: 'a budget on the round trip',
        for: ['duration_under'],
        code: [
          '- type: http',
          '  method: GET',
          '  url: ${base}/health',
          '  assert:',
          '    - type: duration_under',
          '      ms: 500'
        ].join('\n')
      }
    ]
  },
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'prepended to every relative `url`' },
      headers: HEADERS_SCHEMA,
      retry: RETRY_SCHEMA,
      redact: {
        type: 'array',
        items: { type: 'string' },
        description: 'extra field names to mask in what a failed step records — headers, query parameters and JSON keys alike; password, token, api_key and their spellings are always masked'
      }
    },
    additionalProperties: false
  },

  setup(ctx) {
    const root = ctx.host.root

    ctx.defineStepType('http', {
      summary: 'sends one request and hands back status, headers, body and how long it took',
      schema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            description: 'GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS, in either case; GET when absent'
          },
          url: { type: 'string', description: 'absolute, or relative to `http.baseUrl` in speq.yaml' },
          headers: HEADERS_SCHEMA,
          body: {
            description:
              'a string is sent as written; anything else is sent as JSON, with content-type set unless a header says otherwise'
          },
          multipart: {
            type: 'object',
            description: 'a multipart/form-data body: a scalar per plain field, a mapping per file part; excludes `body`',
            additionalProperties: {
              anyOf: [
                { type: ['string', 'number', 'boolean'] },
                {
                  type: 'object',
                  properties: {
                    file: { type: 'string', description: 'a path relative to the project root, read at run time' },
                    content: { type: 'string', description: 'the bytes to send, when they are not on disk' },
                    filename: { type: 'string', description: 'what the server sees; defaults to the file name' },
                    contentType: { type: 'string', description: 'defaults from the file extension' }
                  },
                  additionalProperties: false
                }
              ]
            }
          },
          query: {
            type: 'object',
            description: 'appended to the url as a query string, one key per parameter',
            additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }
          },
          retry: RETRY_SCHEMA
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
        // Case-insensitive on purpose — `get` has always been sent as GET —
        // which is why this is a check and not an `enum`, since an enum
        // would have to list every spelling to say the same thing.
        if (typeof step.method === 'string' && !WHOLE_TEMPLATE.test(step.method) && !METHODS.has(step.method.toUpperCase())) {
          problems.push({
            path: 'method',
            code: 'unknown-method',
            message: `'${step.method}' is not an HTTP method`,
            hint: `one of ${[...METHODS].join(', ')}`
          })
        }
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

        // Recorded before the request goes out, not after it comes back.
        // A connection that is refused has no response to describe it, and
        // this is the step's only chance to say what it was trying to do —
        // the kernel keeps it if the step ends badly and drops it otherwise.
        const hide = redactor(config.redact)
        const request = {
          method,
          url: hide.url(url),
          headers: hide.headers(headers),
          ...(payload instanceof FormData
            ? { multipart: Object.keys(partsOf(input.multipart)) }
            : payload !== undefined ? { body: clip(hide.body(payload)) } : {})
        }
        exec.record({ request })

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

        exec.record({
          request,
          response: {
            status: response.status,
            headers: hide.headers(Object.fromEntries(response.headers)),
            // A response carries credentials too — a login answers with the
            // token the rest of the suite uses — and it is the same sweep.
            body: clip(hide.body(text)),
            attempts
          }
        })

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
      summary: 'the response code of the request the step just made',
      schema: {
        type: 'object',
        properties: { expected: { type: 'integer', description: 'the status code, as a number: 200, not "200"' } },
        required: ['expected'],
        additionalProperties: false
      },
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
      summary: 'the request came back inside a budget, in milliseconds',
      schema: {
        type: 'object',
        properties: { ms: { type: 'number', minimum: 0, description: 'the budget, in milliseconds' } },
        required: ['ms'],
        additionalProperties: false
      },
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
/**
 * Headers written down for a failure are headers written into a CI artifact.
 *
 * `events.jsonl` is uploaded, kept and read by people and programs that had no
 * part in the run, so a recorded `authorization` is a credential handed to all
 * of them. The names are kept — a request that failed for want of a token
 * looks identical to one that never carried it — and only the values go.
 */
const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token'
])

/**
 * Names that carry a credential wherever they are written.
 *
 * Headers were the whole of the redaction, and a header is not where most
 * tokens in a real suite live: `?api_key=` in a query string and
 * `{"password": …}` in a login body both went into `events.jsonl` in full, and
 * `events.jsonl` is uploaded as a CI artifact. Matched on the name with the
 * separators taken out, so `api_key`, `apiKey` and `api-key` are one entry.
 */
const SECRET_KEYS = new Set([
  'password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'apikey', 'apisecret', 'clientsecret', 'privatekey', 'authorization', 'auth', 'credential',
  'credentials', 'sessionid', 'otp'
])

const REDACTED = '(redacted)'

/**
 * Environment variables whose *name* says they hold a credential.
 *
 * The value is what has to be found, because by the time a step runs there is
 * no `${env:TOKEN}` left to recognise — the kernel resolved it, and the plugin
 * is handed the string. So the token is looked for in what is about to be
 * written down, which also catches it in the places a key name never would: a
 * signed URL, a bearer token pasted into a JSON field called `q`.
 *
 * Only secret-named variables, and only values long enough to be one. Masking
 * every environment value would eventually mask `/home/mira` out of a body and
 * make the log a puzzle.
 */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|AUTH)/i
const SHORTEST_SECRET = 8

function secretName(name: string, extra: Set<string>): boolean {
  const bare = name.toLowerCase().replace(/[-_\s]/g, '')
  return SECRET_KEYS.has(bare) || extra.has(bare) || SECRET_HEADERS.has(name.toLowerCase())
}

/** The values in this process that must never reach a report. */
function secretValues(): string[] {
  const found: string[] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= SHORTEST_SECRET && SECRET_ENV.test(name)) found.push(value)
  }
  // Longest first, so a token that contains another token's prefix is masked
  // whole rather than leaving a tail behind.
  return found.sort((a, b) => b.length - a.length)
}

function maskValues(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join(REDACTED)
  return out
}

/**
 * One redactor per step, so the environment is read once rather than per
 * header, and the extra names come from the project's own config.
 */
function redactor(extra: string[] | undefined): {
  headers(headers: Record<string, string>): Record<string, string>
  url(url: string): string
  body(body: string): string
} {
  const names = new Set((extra ?? []).map((n) => n.toLowerCase().replace(/[-_\s]/g, '')))
  const secrets = secretValues()

  const text = (value: string): string => maskValues(value, secrets)

  return {
    headers(headers) {
      const out: Record<string, string> = {}
      for (const [name, value] of Object.entries(headers)) {
        out[name] = secretName(name, names) ? REDACTED : text(value)
      }
      return out
    },

    url(url) {
      // Parsed rather than pattern-matched: a query string is the one place a
      // credential is both common and invisible, and `?token=` needs to be
      // masked whether it arrived encoded, repeated or last.
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return text(url)
      }
      for (const key of [...parsed.searchParams.keys()]) {
        if (secretName(key, names)) parsed.searchParams.set(key, REDACTED)
      }
      return text(parsed.toString())
    },

    body(body) {
      // JSON when it is JSON, so `{"password": "…"}` is masked by its key and
      // the rest of the body stays readable. Anything else is still swept for
      // the values, which is what catches a form-encoded login.
      try {
        const parsed: unknown = JSON.parse(body)
        return JSON.stringify(maskKeys(parsed, names))
      } catch {
        return text(body)
      }
    }
  }

  function maskKeys(value: unknown, names: Set<string>): unknown {
    if (Array.isArray(value)) return value.map((v) => maskKeys(v, names))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = secretName(key, names)
          ? REDACTED
          : typeof inner === 'string' ? text(inner) : maskKeys(inner, names)
      }
      return out
    }
    return typeof value === 'string' ? text(value) : value
  }
}

/**
 * A body is unbounded and a run log is not.
 *
 * Enough of a payload to see what went wrong, and not a 40 MB export in the
 * event stream of every failed step. What was cut is said out loud, so nobody
 * debugs against a body they think is complete.
 */
const RECORDED_BODY_LIMIT = 8192

function clip(body: string | FormData): string {
  if (typeof body !== 'string') return '(form data)'
  return body.length <= RECORDED_BODY_LIMIT
    ? body
    : `${body.slice(0, RECORDED_BODY_LIMIT)}… (${body.length - RECORDED_BODY_LIMIT} more characters)`
}

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
