#!/usr/bin/env node
/**
 * The API `examples/basic` talks to, when the run has to be repeatable.
 *
 *   node scripts/example-api.mjs -- speq run --env ci --test suites/health.yaml
 *
 * It starts on a free port, puts that port in `API_URL` for the child, runs
 * the child, and exits with whatever the child exited with. Nothing races on
 * startup, because the child is not spawned until the socket is listening.
 *
 * Why it exists: the example points at jsonplaceholder.typicode.com, which is
 * the right thing for a person trying speq on a laptop and the wrong thing for
 * a gate. A CI job that goes over the public internet reports somebody else's
 * outage as our broken example, and the one path every newcomer takes is worth
 * more than that. The `ci` environment already reads
 * `${env:API_URL:-…jsonplaceholder…}`, so pointing it here changes nothing a
 * reader of the example has to know.
 *
 * The shapes are jsonplaceholder's, because the example's assertions are.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const command = separator >= 0 ? argv.slice(separator + 1) : []

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const post = /^\/posts\/(\d+)$/.exec(path)

  if (post) {
    const id = Number(post[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      userId: 1,
      id,
      title: `post ${id}`,
      body: 'the example does not care what is in here, only that it came back'
    }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: `nothing at ${path}` }))
})

await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const base = `http://127.0.0.1:${server.address().port}`

if (command.length === 0) {
  process.stdout.write(`${base}\n`)
} else {
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, API_URL: base }
  })
  const code = await new Promise((done) => child.on('exit', (status, signal) => done(signal ? 1 : status ?? 1)))
  server.close()
  process.exit(code)
}
