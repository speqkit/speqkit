import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import type { RunEvent } from '@speqkit/plugin-api'
import yaml from '@speqkit/plugin-yaml'
import http from '@speqkit/plugin-http'
import assert from '@speqkit/plugin-assert'
import ui, {
  artifactHref, contained, foldRun, historyOf, parse, readProject, serve, summarise,
  type ProjectDocument, type Serving
} from '@speqkit/plugin-ui'

let kit: Harness
let serving: Serving | undefined

afterEach(async () => {
  await serving?.close()
  serving = undefined
  await kit?.close()
})

/* ------------------------------------------------------------------ */
/* Reading a recorded run                                              */
/* ------------------------------------------------------------------ */

const run = (): RunEvent => ({ type: 'run.started', runId: 'r1', tests: 2, at: 1_700_000_000_000 })
const done = (over: Partial<Extract<RunEvent, { type: 'run.finished' }>> = {}): RunEvent => ({
  type: 'run.finished', runId: 'r1', status: 'failed',
  passed: 1, failed: 1, errored: 0, skipped: 0, durationMs: 40, ...over
})

describe('the fold', () => {
  it('nests steps and hangs each assertion where it belongs', () => {
    const document = foldRun([
      run(),
      { type: 'suite.started', suite: 'suites/pay.yaml', title: 'payments' },
      { type: 'test.started', test: 'refund', suite: 'suites/pay.yaml', tags: ['smoke'] },
      { type: 'step.started', test: 'refund', stepId: 'seed', stepType: 'loop', depth: 1 },
      { type: 'step.started', test: 'refund', stepId: 'get', stepType: 'http', parentId: 'seed', depth: 2 },
      {
        type: 'step.finished', test: 'refund', stepId: 'get', stepType: 'http', parentId: 'seed',
        depth: 2, status: 'passed', durationMs: 7
      },
      { type: 'step.finished', test: 'refund', stepId: 'seed', stepType: 'loop', depth: 1, status: 'passed', durationMs: 9 },
      { type: 'assertion.evaluated', test: 'refund', assertionType: 'equals', passed: false, message: 'body.id is 1', expected: 1, actual: 2 },
      { type: 'test.finished', test: 'refund', status: 'failed', durationMs: 12 },
      { type: 'suite.finished', suite: 'suites/pay.yaml' },
      done()
    ], 'r1')

    const test = document.tests[0]!
    expect(document.suites[0]!.title).toBe('payments')
    expect(test.steps[0]!.steps.map((s) => s.id)).toEqual(['get'])
    expect(test.assertions[0]).toMatchObject({ expected: 1, actual: 2 })
    expect(test.failures).toEqual(['assertion equals: body.id is 1'])
    expect(document.totals).toEqual({ tests: 2, passed: 1, failed: 1, error: 0, skipped: 0 })
  })

  it('never lets the browser see a path on the machine that ran the tests', () => {
    const document = foldRun([
      run(),
      { type: 'test.started', test: 'shot' },
      {
        type: 'artifact.attached', test: 'shot', name: 'home.png', contentType: 'image/png',
        bytes: 12, path: '/Users/someone/work/repo/.speq/reports/r1/artifacts/shot/home.png'
      },
      { type: 'test.finished', test: 'shot', status: 'passed', durationMs: 1 },
      done({ status: 'passed', passed: 1, failed: 0 })
    ], 'r1')

    // A page that can name a file on the machine is a page that can ask for
    // one. What crosses is the tail from the run id onwards, which is exactly
    // what the server can resolve again inside the report directory.
    expect(document.tests[0]!.artifacts[0]!.href).toBe('/artifacts/r1/artifacts/shot/home.png')
    expect(JSON.stringify(document)).not.toContain('/Users/someone')
  })

  it('keeps two suites apart when their events interleave', () => {
    // G4: a reporter may see two stories at once, and every event names the
    // test it belongs to. Reading adjacency is the fault shipped twice already.
    const document = foldRun([
      run(),
      { type: 'test.started', test: 'a1', suite: 'a.yaml' },
      { type: 'test.started', test: 'b1', suite: 'b.yaml' },
      { type: 'step.started', test: 'b1', stepId: 'bs', stepType: 'http', depth: 1 },
      { type: 'step.started', test: 'a1', stepId: 'as', stepType: 'http', depth: 1 },
      { type: 'step.finished', test: 'a1', stepId: 'as', stepType: 'http', depth: 1, status: 'passed', durationMs: 1 },
      { type: 'step.finished', test: 'b1', stepId: 'bs', stepType: 'http', depth: 1, status: 'passed', durationMs: 1 },
      { type: 'test.finished', test: 'b1', status: 'passed', durationMs: 2 },
      { type: 'test.finished', test: 'a1', status: 'passed', durationMs: 3 },
      done({ status: 'passed', passed: 2, failed: 0 })
    ], 'r1')

    const byName = new Map(document.tests.map((t) => [t.name, t]))
    expect(byName.get('a1')!.steps.map((s) => s.id)).toEqual(['as'])
    expect(byName.get('b1')!.steps.map((s) => s.id)).toEqual(['bs'])
  })
})

describe('a run on disk', () => {
  function record(root: string, id: string, events: RunEvent[]): { runId: string; dir: string; at: number } {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`)
    return { runId: id, dir, at: 0 }
  }

  it('summarises without folding, and says so when a run never finished', async () => {
    kit = await harness(ui)
    const reports = join(kit.root, 'reports')

    const whole = record(reports, 'whole', [
      run(),
      { type: 'test.started', test: 'a' },
      { type: 'test.finished', test: 'a', status: 'passed', durationMs: 5 },
      done({ status: 'passed', passed: 1, failed: 0 })
    ])
    // A process killed mid-run leaves a log with no `run.finished`. Leaving the
    // row out would hide the only evidence there is of what happened.
    const crashed = record(reports, 'crashed', [run(), { type: 'test.started', test: 'a' }])

    expect(summarise(whole)).toMatchObject({ status: 'passed', durationMs: 40 })
    expect(summarise(crashed).status).toBe('error')
    expect(summarise(crashed).at).toBe(1_700_000_000_000)
  })

  it('reads a half-written last line rather than refusing the run', async () => {
    kit = await harness(ui)
    const dir = join(kit.root, 'reports', 'torn')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${JSON.stringify(run())}\n${JSON.stringify({ type: 'test.started', test: 'a' })}\n{"type":"test.fin`
    )

    // A run that crashed is exactly the run somebody opened this page to read.
    expect(summarise({ runId: 'torn', dir, at: 0 }).at).toBe(1_700_000_000_000)
  })

  it('gathers each test across runs, newest run last on disk order', async () => {
    kit = await harness(ui)
    const reports = join(kit.root, 'reports')
    const one = record(reports, 'one', [
      run(),
      { type: 'test.finished', test: 'refund', status: 'passed', durationMs: 5 },
      done({ status: 'passed', passed: 1, failed: 0 })
    ])
    const two = record(reports, 'two', [
      { type: 'run.started', runId: 'r2', tests: 1, at: 1_700_000_100_000 },
      { type: 'test.finished', test: 'refund', status: 'failed', durationMs: 9 },
      { type: 'run.finished', runId: 'r2', status: 'failed', passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 9 }
    ])

    const history = historyOf([two, one])
    // Not "did this fail" but "does this fail" — the question a suite tree
    // cannot answer and one report cannot either.
    expect(history.tests.refund!.map((p) => p.status)).toEqual(['failed', 'passed'])
    expect(history.runs.map((r) => r.status)).toEqual(['failed', 'passed'])
  })

  it('anchors an artifact URL on the run id, wherever the reports directory is', () => {
    expect(artifactHref('r1', '/a/b/.speq/reports/r1/artifacts/t/home.png'))
      .toBe('/artifacts/r1/artifacts/t/home.png')
    // Windows separators, and a path that does not contain the run id at all.
    expect(artifactHref('r1', 'C:\\repo\\.speq\\reports\\r1\\artifacts\\t\\home.png'))
      .toBe('/artifacts/r1/artifacts/t/home.png')
    expect(artifactHref('r1', 'loose.png')).toBe('/artifacts/r1/loose.png')
  })
})

/* ------------------------------------------------------------------ */
/* Containment — the whole of the server's security story              */
/* ------------------------------------------------------------------ */

describe('what a request may reach', () => {
  it('refuses anything that resolves outside the directory', () => {
    expect(contained('/base', 'a/b.png')).toBe('/base/a/b.png')
    expect(contained('/base', '../secret')).toBeUndefined()
    expect(contained('/base', 'a/../../secret')).toBeUndefined()
    expect(contained('/base', '/etc/passwd')).toBeUndefined()
    // The trailing separator on the base is what stops a sibling directory
    // whose name starts with the same letters from passing as being inside it.
    expect(contained('/base', '../base-evil/x')).toBeUndefined()
    expect(contained('/base', '')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* The server, against a real project                                  */
/* ------------------------------------------------------------------ */

describe('the panel', () => {
  async function project(): Promise<Harness> {
    const kit = await harness(ui, {
      with: [yaml, http, assert],
      config: { http: { baseUrl: 'https://example.com' } }
    })
    kit.file(
      'suites/pay.yaml',
      [
        'id: refund lands',
        'tags: [smoke]',
        'steps:',
        '  - id: post',
        '    type: http',
        '    method: GET',
        '    url: /orders/1',
        'assert:',
        '  - type: status',
        '    expected: 200'
      ].join('\n')
    )
    return kit
  }

  it('answers with the project the kernel would run', async () => {
    kit = await project()
    const document = await readProject(kit.host)

    expect(document.tests.map((t) => t.name)).toEqual(['refund lands'])
    expect(document.files).toEqual(['suites/pay.yaml'])
    expect(document.diagnostics).toEqual([])
    // The question the page exists to answer: whose word is `http`. It is taken
    // from the running session, so a project with one more plugin installed has
    // one more answer — a table baked in here would be wrong and silent.
    const step = document.capabilities.stepTypes.find((s) => s.name === 'http')
    expect(step?.plugin).toBe('@speqkit/plugin-http')
  })

  it('shows a typo as a diagnostic rather than as a test that never ran', async () => {
    kit = await project()
    kit.file('suites/typo.yaml', ['id: a typo', 'steps:', '  - type: htpp', '    url: /x'].join('\n'))

    const document = await readProject(kit.host)
    expect(document.diagnostics.map((d) => d.code)).toContain('unknown-step-type')
  })

  it('serves the page, the project, the runs and a test file — and nothing else', async () => {
    kit = await project()
    serving = await serve({ host: kit.host, port: 0 })

    const page = await fetch(serving.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    // One document, nothing outside it: no bundler between this repository and
    // a working `speq ui`, and nothing to fetch from anybody else's server.
    const html = await page.text()
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/)

    const document = (await (await fetch(`${serving.url}api/project`)).json()) as ProjectDocument
    expect(document.tests[0]!.name).toBe('refund lands')

    const source = (await (await fetch(`${serving.url}api/source?file=suites/pay.yaml`)).json()) as { text: string }
    expect(source.text).toContain('id: refund lands')

    expect((await fetch(`${serving.url}api/runs`)).status).toBe(200)
    expect((await fetch(`${serving.url}nope`)).status).toBe(404)
  })

  it('refuses a path that climbs out of the project, however it is spelled', async () => {
    kit = await project()
    serving = await serve({ host: kit.host, port: 0 })

    for (const attempt of [
      'api/source?file=../../../../etc/passwd',
      `api/source?file=${encodeURIComponent('../../etc/passwd')}`,
      'artifacts/../../speq.yaml',
      `artifacts/${encodeURIComponent('../../speq.yaml')}`
    ]) {
      expect((await fetch(serving.url + attempt)).status, attempt).toBe(404)
    }
  })

  it('answers only reads, and tells a browser not to guess types', async () => {
    kit = await project()
    serving = await serve({ host: kit.host, port: 0 })

    const posted = await fetch(`${serving.url}api/project`, { method: 'POST' })
    expect(posted.status).toBe(405)
    // An artifact is a file the system under test produced. Without this a
    // browser is free to decide a recorded body is HTML and run it, on this
    // origin, next to everything else the page can read.
    expect((await fetch(serving.url)).headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('binds loopback unless somebody says otherwise', async () => {
    kit = await project()
    serving = await serve({ host: kit.host, port: 0 })
    expect(serving.url.startsWith('http://127.0.0.1:')).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* The command                                                         */
/* ------------------------------------------------------------------ */

describe('the flags', () => {
  it('reads the three it has', () => {
    expect(parse([])).toEqual({})
    expect(parse(['--port', '4000', '--no-open'])).toEqual({ port: 4000, open: false })
    expect(parse(['--host', '0.0.0.0', '--open'])).toEqual({ host: '0.0.0.0', open: true })
  })

  it('refuses rather than ignores, because a dropped flag is a setting somebody believes in', () => {
    expect(parse(['--prot', '4000'])).toContain("unknown flag '--prot'")
    expect(parse(['--port'])).toContain('--port needs a value')
    expect(parse(['--port', 'four'])).toContain('--port wants 0-65535')
    expect(parse(['--port', '70000'])).toContain('--port wants 0-65535')
  })
})
