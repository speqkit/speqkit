import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import http from '@speqkit/plugin-http'

/**
 * Driven against a real server on a real socket.
 *
 * A stub `fetch` would test that this plugin agrees with our stub, and the two
 * things being added here — a multipart body and a retry policy — are exactly
 * the two whose bugs live in what actually goes over the wire.
 */

let kit: Harness
let server: Server
let base: string
let seen: { method: string; url: string; contentType?: string; body: string }[]
let answer: (n: number) => { status: number; body?: string; contentType?: string }

beforeEach(async () => {
  seen = []
  answer = () => ({ status: 200, body: '{"ok":true}', contentType: 'application/json' })
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8')
      })
      const reply = answer(seen.length)
      res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
      res.end(reply.body ?? '{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  await kit?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

async function withHttp(config: Record<string, unknown> = {}): Promise<Harness> {
  kit = await harness(http, { config: { http: { baseUrl: base, ...config } } })
  return kit
}

describe('a request', () => {
  it('sends a JSON body and reads the answer apart', async () => {
    const kit = await withHttp()
    const step = await kit.step({ type: 'http', method: 'POST', url: '/orders', body: { sku: 'a1' } })

    expect(seen[0]).toMatchObject({ method: 'POST', url: '/orders', contentType: 'application/json' })
    expect(JSON.parse(seen[0]!.body)).toEqual({ sku: 'a1' })
    expect(step.result).toMatchObject({ status: 200, ok: true, body: { ok: true }, attempts: 1 })
  })

  it('refuses a key it does not know, before anything is sent', async () => {
    const kit = await withHttp()

    // The bug this plugin exists not to have. Under speq 1.x `multipart`,
    // `formData`, `form`, `files`, `bodyFile` and `bodyRaw` were all accepted
    // and all silently ignored — the request went out empty and the test
    // reported passed, so three upload paths went untested behind a green
    // tick. A closed schema is what makes that impossible.
    const diagnostics = kit.validate([{
      name: 't',
      source: 'suites/t.yaml',
      steps: [{ type: 'http', url: '/uploads', bodyRaw: 'anything' }]
    }])
    expect(diagnostics[0]?.message).toMatch(/unknown field 'bodyRaw'/)
  })
})

describe('multipart', () => {
  it('sends a file from disk with a boundary the server can parse', async () => {
    const kit = await withHttp()
    writeFileSync(join(kit.root, 'tiny.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

    await kit.step({
      type: 'http',
      method: 'POST',
      url: '/uploads',
      multipart: { kind: 'variant_image', file: { file: 'tiny.png' } }
    })

    const request = seen[0]!
    expect(request.contentType).toMatch(/^multipart\/form-data; boundary=/)
    // The boundary in the header is the one in the body. Writing the header by
    // hand is how that stops being true, which a server reports as a malformed
    // body several layers from the line that caused it.
    const boundary = /boundary=(.+)$/.exec(request.contentType!)![1]!
    expect(request.body).toContain(`--${boundary}`)
    expect(request.body).toContain('name="kind"')
    expect(request.body).toContain('variant_image')
    expect(request.body).toContain('name="file"; filename="tiny.png"')
    expect(request.body).toContain('Content-Type: image/png')
  })

  it('sends content a step produced, with the name and type it is given', async () => {
    const kit = await withHttp()
    await kit.step({
      type: 'http',
      method: 'POST',
      url: '/uploads',
      multipart: { doc: { content: 'a,b\n1,2\n', filename: 'rows.csv' } }
    })

    expect(seen[0]!.body).toContain('filename="rows.csv"')
    expect(seen[0]!.body).toContain('Content-Type: text/csv')
    expect(seen[0]!.body).toContain('a,b')
  })

  it('does not let a hand-written content-type override the boundary', async () => {
    const kit = await withHttp()
    await kit.step({
      type: 'http',
      method: 'POST',
      url: '/uploads',
      headers: { 'Content-Type': 'multipart/form-data' },
      multipart: { kind: 'x' }
    })

    expect(seen[0]!.contentType).toMatch(/boundary=/)
  })

  it('says which file is missing, before the run', async () => {
    const kit = await withHttp()
    const diagnostics = kit.validate([{
      name: 't',
      source: 'suites/t.yaml',
      steps: [{ type: 'http', url: '/uploads', multipart: { file: { file: 'fixtures/nope.png' } } }]
    }])

    expect(diagnostics[0]).toMatchObject({ path: 'steps[0].multipart.file.file' })
    expect(diagnostics[0]!.message).toMatch(/no such file/)
  })

  it('has nothing to look for when a part carries its own content', async () => {
    const kit = await withHttp()

    // A part built from `content:` is one the step produced. Looking for it on
    // disk found a path spelled `undefined` and refused every generated body.
    expect(kit.validate([{
      name: 't',
      source: 'suites/t.yaml',
      steps: [{ type: 'http', url: '/uploads', multipart: { doc: { content: 'x', filename: 'a.txt' } } }]
    }])).toEqual([])
  })

  it('refuses a request with two bodies', async () => {
    const kit = await withHttp()
    const diagnostics = kit.validate([{
      name: 't',
      source: 'suites/t.yaml',
      steps: [{ type: 'http', url: '/uploads', body: { a: 1 }, multipart: { b: '2' } }]
    }])

    expect(diagnostics[0]!.message).toBe("'body' and 'multipart' exclude each other")
  })
})

describe('retrying', () => {
  it('is off until a project asks for it', async () => {
    const kit = await withHttp()
    answer = () => ({ status: 503 })

    const step = await kit.step({ type: 'http', url: '/health' })
    expect(step.result.attempts).toBe(1)
    expect(seen).toHaveLength(1)
  })

  it('asks again through the gap between the container and the API', async () => {
    const kit = await withHttp({ retry: { attempts: 3, delayMs: 1 } })
    answer = (n) => (n < 3 ? { status: 503 } : { status: 200 })

    const step = await kit.step({ type: 'http', url: '/health' })
    expect(step.result).toMatchObject({ status: 200, attempts: 3 })
  })

  it('never retries a 429, whatever the policy says', async () => {
    const kit = await withHttp({ retry: { attempts: 5, delayMs: 1 } })
    answer = () => ({ status: 429 })

    // A rate limiter is behaviour a suite tests. A policy that quietly repeats
    // through a 429 makes the test that proves the limiter works pass whether
    // the limiter exists or not — worse than not having the test.
    const step = await kit.step({ type: 'http', url: '/auth/login' })
    expect(step.result).toMatchObject({ status: 429, attempts: 1 })
  })

  it('does not repeat a POST unless the project names it', async () => {
    const kit = await withHttp({ retry: { attempts: 3, delayMs: 1 } })
    answer = (n) => (n < 3 ? { status: 503 } : { status: 201 })

    // A 502 means a gateway answered; it does not mean the origin never saw
    // the request. Repeating a POST creates the row twice and the failure
    // surfaces somewhere else entirely.
    const guarded = await kit.step({ type: 'http', method: 'POST', url: '/orders', body: {} })
    expect(guarded.result.attempts).toBe(1)

    seen = []
    answer = (n) => (n < 2 ? { status: 503 } : { status: 201 })
    const opted = await kit.step({
      type: 'http', method: 'POST', url: '/orders', body: {}, retry: { methods: ['POST'] }
    })
    expect(opted.result).toMatchObject({ status: 201, attempts: 2 })
  })

  it('gives up after the attempts it was given and reports what it got', async () => {
    const kit = await withHttp({ retry: { attempts: 2, delayMs: 1 } })
    answer = () => ({ status: 504 })

    const step = await kit.step({ type: 'http', url: '/health' })
    expect(step.result).toMatchObject({ status: 504, attempts: 2 })
    expect(step.status).toBe('passed')
  })

  it("is a step's own business when it says so", async () => {
    const kit = await withHttp()
    answer = (n) => (n < 2 ? { status: 502 } : { status: 200 })

    const step = await kit.step({ type: 'http', url: '/health', retry: { attempts: 4, delayMs: 1 } })
    expect(step.result.attempts).toBe(2)
  })
})

describe('a request that never arrives', () => {
  it('names the URL and what the socket said', async () => {
    // A port nobody is listening on: bound to find a free one, then released.
    const spare = createServer()
    await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r))
    const address = spare.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((r) => spare.close(() => r()))

    const kit = await withHttp({ baseUrl: `http://127.0.0.1:${port}` })
    const step = await kit.step({ type: 'http', url: '/health' })

    // What used to come out of here was 'fetch failed' — undici's wrapper,
    // four words, no port, no errno, identical for a refused connection, an
    // unknown host and a bad certificate. The cause was on the error the
    // whole time and was being dropped on the way out.
    expect(step.status).toBe('error')
    expect(step.message).toContain(`GET http://127.0.0.1:${port}/health failed`)
    expect(step.message).toMatch(/ECONNREFUSED/)
    expect(step.message).not.toBe('fetch failed')
  })

  it('says how many times it asked before giving up', async () => {
    const spare = createServer()
    await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r))
    const address = spare.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((r) => spare.close(() => r()))

    const kit = await withHttp({ baseUrl: `http://127.0.0.1:${port}`, retry: { attempts: 2, delayMs: 1 } })
    const step = await kit.step({ type: 'http', url: '/health' })

    expect(step.message).toContain('failed after 2 attempts')
  })
})

/**
 * A step that failed used to leave a status code and a sentence behind it. The
 * request it sent was in nobody's hands: not in the result — a response has no
 * room for it — and not in the event stream, which carried neither.
 */
describe('the exchange, when the exchange is what is in question', () => {
  const failing = { type: 'status', expected: 418 }

  it('records the request beside the response when the step did not pass', async () => {
    const kit = await withHttp()
    const step = await kit.step({
      type: 'http', method: 'POST', url: '/orders', body: { sku: 'a1' }, assert: [failing]
    })

    expect(step.status).toBe('failed')
    const detail = step.detail as { request: Record<string, unknown>; response: Record<string, unknown> }
    expect(detail.request).toMatchObject({ method: 'POST', url: `${base}/orders`, body: '{"sku":"a1"}' })
    expect(detail.response).toMatchObject({ status: 200, body: '{"ok":true}', attempts: 1 })
  })

  it('keeps none of it when the step passed', async () => {
    const kit = await withHttp()
    const step = await kit.step({ type: 'http', url: '/orders', assert: [{ type: 'status', expected: 200 }] })

    expect(step.status).toBe('passed')
    expect(step.detail).toBeUndefined()
  })

  /**
   * `events.jsonl` is uploaded by CI and read by people who had no part in the
   * run. A recorded `authorization` is a credential handed to all of them —
   * and the header's *name* is kept, because a request that failed for want of
   * a token looks identical to one that never carried it.
   */
  it('writes down the header names and not the secrets in them', async () => {
    const kit = await withHttp({ headers: { authorization: 'Bearer sk-live-42' } })
    const step = await kit.step({
      type: 'http', url: '/orders', headers: { 'x-api-key': 'k-99' }, assert: [failing]
    })

    const detail = step.detail as { request: { headers: Record<string, string> } }
    expect(detail.request.headers).toMatchObject({
      authorization: '(redacted)',
      'x-api-key': '(redacted)'
    })
    expect(JSON.stringify(step.detail)).not.toContain('sk-live-42')
    expect(JSON.stringify(step.detail)).not.toContain('k-99')
  })

  it('records what it was trying to do when nothing came back at all', async () => {
    const spare = createServer()
    await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r))
    const address = spare.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((r) => spare.close(() => r()))

    const kit = await withHttp({ baseUrl: `http://127.0.0.1:${port}` })
    const step = await kit.step({ type: 'http', method: 'PUT', url: '/health', body: { ping: 1 } })

    // There is no response to describe and the request is the whole of what
    // can be said. Recorded before the socket was opened, for exactly this.
    expect(step.status).toBe('error')
    const detail = step.detail as { request: Record<string, unknown>; response?: unknown }
    expect(detail.request).toMatchObject({ method: 'PUT', url: `http://127.0.0.1:${port}/health` })
    expect(detail.response).toBeUndefined()
  })
})
