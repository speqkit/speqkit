import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, relative, resolve, sep } from 'node:path'
import type { Host } from '@speqkit/plugin-api'
import { readProject } from './project.js'
import { foldRun, historyOf, readEvents, summarise } from './runs.js'
import { page } from './app.js'

export interface ServeOptions {
  host: Host
  /** The interface to bind. Loopback by default — see `listen`. */
  address?: string
  /** 0 asks the operating system for a free one, which is what `--port 0` does. */
  port?: number
}

export interface Serving {
  url: string
  port: number
  close(): Promise<void>
}

/**
 * The panel, as an HTTP server in the session that already loaded the plugins.
 *
 * It is in-process on purpose. A separate program reading `.speq/` off disk
 * would have to re-implement discovery, the loaders and the plugin resolution
 * to answer a single question about a step type — and would answer it
 * differently from the kernel the moment either changed. Here the page asks
 * the same `ctx.host` the CLI asks, so what it shows is what a run would do.
 *
 * Read-only, deliberately and for now. `RunRequest` has no cancellation
 * signal, so a Run button in a browser would start something the browser
 * cannot stop — and a suite against a real system is exactly the thing you
 * want to be able to stop. The roadmap names that as the blocker; until it
 * lifts, this shows what is there.
 */
export function serve(options: ServeOptions): Promise<Serving> {
  const { host } = options
  const address = options.address ?? '127.0.0.1'
  const reportDir = resolve(host.reportDir)
  const root = resolve(host.root)

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      send(response, 500, 'application/json', JSON.stringify({ error: message(error) }))
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A page that only reads should only answer reads: anything else is a
    // request nobody here wrote and is refused before it is routed.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain', 'this server only answers GET')
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)

    if (path === '/' || path === '/index.html') {
      send(response, 200, 'text/html; charset=utf-8', page())
      return
    }

    if (path === '/api/project') {
      send(response, 200, JSON_TYPE, JSON.stringify(await readProject(host)))
      return
    }

    if (path === '/api/runs') {
      send(response, 200, JSON_TYPE, JSON.stringify(host.runs().map(summarise)))
      return
    }

    if (path === '/api/history') {
      // Bounded, and newest first: the strip is about the recent past, and a
      // project that has been running nightly for a year would otherwise fold
      // a year of logs to draw twenty squares.
      const limit = Number(url.searchParams.get('limit') ?? 30)
      send(response, 200, JSON_TYPE, JSON.stringify(historyOf(host.runs().slice(0, clamp(limit)))))
      return
    }

    if (path.startsWith('/api/runs/')) {
      const id = path.slice('/api/runs/'.length)
      const run = host.runs().find((candidate) => candidate.runId === id)
      if (!run) {
        send(response, 404, JSON_TYPE, JSON.stringify({ error: `no recorded run ${id}` }))
        return
      }
      send(response, 200, JSON_TYPE, JSON.stringify(foldRun(readEvents(run.dir), run.runId)))
      return
    }

    if (path === '/api/source') {
      const wanted = url.searchParams.get('file') ?? ''
      const file = contained(root, wanted)
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        send(response, 404, JSON_TYPE, JSON.stringify({ error: `no file ${wanted} under the project root` }))
        return
      }
      send(response, 200, JSON_TYPE, JSON.stringify({ file: wanted, text: await readFile(file, 'utf8') }))
      return
    }

    if (path.startsWith('/artifacts/')) {
      const file = contained(reportDir, path.slice('/artifacts/'.length))
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        send(response, 404, 'text/plain', 'no such artifact')
        return
      }
      response.writeHead(200, {
        'content-type': typeOf(file),
        'content-length': String(statSync(file).size),
        ...NO_SNIFF
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      createReadStream(file).pipe(response)
      return
    }

    send(response, 404, 'text/plain', 'not found')
  }

  return new Promise<Serving>((accept, reject) => {
    server.on('error', reject)
    // Loopback by default, and it is not a default anybody should change
    // lightly: this serves the source of every test in the project and every
    // response body every run recorded, with no authentication, to whoever
    // asks. On a shared network that is the whole project.
    server.listen(options.port ?? 0, address, () => {
      const bound = server.address()
      const port = typeof bound === 'object' && bound ? bound.port : 0
      accept({ url: `http://${display(address)}:${port}/`, port, close: () => shut(server) })
    })
  })
}

/** A limit out of a query string is a number somebody can type, so it is read as one. */
function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), 200) : 30
}

const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * `nosniff` on every response, and it matters most on the artifacts.
 *
 * An artifact is a file the system under test produced. Served without this,
 * a browser is free to decide that a response body saved as `.txt` is really
 * HTML and run whatever is in it — on this origin, next to everything else the
 * page can read.
 */
const NO_SNIFF = { 'x-content-type-options': 'nosniff' } as const

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'content-type': type,
    'content-length': String(Buffer.byteLength(body)),
    ...NO_SNIFF
  })
  response.end(body)
}

/**
 * Resolves a request path inside a directory, or refuses.
 *
 * The check is on the *resolved* path rather than on the text of the request:
 * `..` can arrive encoded, doubled, or as a symlink, and only asking where the
 * path actually landed answers all three at once. The trailing separator on
 * the base is what stops `/reports-evil` from passing as being inside
 * `/reports`.
 */
export function contained(base: string, candidate: string): string | undefined {
  if (!candidate) return undefined
  const target = resolve(base, candidate)
  const inside = relative(base, target)
  if (inside === '' || inside.startsWith('..') || resolve(base, inside) !== target) return undefined
  return target.startsWith(base.endsWith(sep) ? base : base + sep) ? target : undefined
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4'
}

/**
 * `.html` and `.svg` deliberately answer as something other than themselves.
 *
 * Both are documents a browser will execute script from, and both are things a
 * test attaches when it captures a page. Serving a captured page as `text/html`
 * on this origin would let a system under test run code next to the project
 * view; as `text/plain` it is a thing you read, which is what it was attached
 * for. SVG stays an image because it is served with `nosniff` and rendered in
 * an `<img>`, where script does not run.
 */
function typeOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return (dot >= 0 ? TYPES[file.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream'
}

/** IPv6 wants brackets in a URL, and `0.0.0.0` is not an address to visit. */
function display(address: string): string {
  if (address === '0.0.0.0' || address === '::') return 'localhost'
  return address.includes(':') ? `[${address}]` : address
}

function shut(server: Server): Promise<void> {
  return new Promise((accept) => {
    server.closeAllConnections?.()
    server.close(() => accept())
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
