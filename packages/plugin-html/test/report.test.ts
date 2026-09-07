import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capabilities, RunEvent } from '@speqkit/plugin-api'
import {
  ReportBuilder, embedArtifacts, ownersOf, renderHtml, targetFile,
  type HtmlReport
} from '@speqkit/plugin-html'

/**
 * The fold from events to the document, and the document to one file.
 *
 * The same argument `packages/plugin-junit/test/build.test.ts` makes: fed a
 * hand-written stream, the fold has nothing else it could have read. What is
 * extra here is the *page* — a report is a place where a response body chosen
 * by the system under test lands inside markup, so the escaping is checked
 * rather than assumed.
 */
function fold(events: RunEvent[], context: Parameters<ReportBuilder['result']>[0] = {}): HtmlReport {
  const builder = new ReportBuilder()
  for (const event of events) builder.on(event)
  return builder.result(context)
}

const run = (): RunEvent => ({ type: 'run.started', runId: 'r1', tests: 1, at: 1_700_000_000_000 })
const done = (over: Partial<Extract<RunEvent, { type: 'run.finished' }>> = {}): RunEvent => ({
  type: 'run.finished', runId: 'r1', status: 'passed',
  passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 40, ...over
})
const started = (test: string, extra: Partial<Extract<RunEvent, { type: 'test.started' }>> = {}): RunEvent =>
  ({ type: 'test.started', test, ...extra })
const finished = (
  test: string,
  status: 'passed' | 'failed' | 'error' | 'skipped',
  durationMs: number
): RunEvent => ({ type: 'test.finished', test, status, durationMs })

describe('the fold', () => {
  it('nests steps, and hangs each assertion where it belongs', () => {
    const report = fold([
      run(),
      { type: 'suite.started', suite: 'suites/pay.yaml' },
      started('refund', { suite: 'suites/pay.yaml', source: 'suites/pay.yaml', tags: ['smoke'] }),
      { type: 'step.started', test: 'refund', stepId: 'seed', stepType: 'loop', depth: 1 },
      { type: 'step.started', test: 'refund', stepId: 'fetch', stepType: 'http', parentId: 'seed', depth: 2 },
      {
        type: 'step.finished', test: 'refund', stepId: 'fetch', stepType: 'http',
        parentId: 'seed', depth: 2, status: 'passed', durationMs: 7
      },
      { type: 'step.finished', test: 'refund', stepId: 'seed', stepType: 'loop', depth: 1, status: 'passed', durationMs: 9 },
      { type: 'step.started', test: 'refund', stepId: 'post', stepType: 'http', depth: 1 },
      { type: 'step.finished', test: 'refund', stepId: 'post', stepType: 'http', depth: 1, status: 'passed', durationMs: 4 },
      { type: 'assertion.evaluated', test: 'refund', assertionType: 'status', passed: true, message: 'status is 200', stepId: 'post' },
      { type: 'assertion.evaluated', test: 'refund', assertionType: 'equals', passed: true, message: 'body.id is 1' },
      finished('refund', 'passed', 20),
      { type: 'suite.finished', suite: 'suites/pay.yaml' },
      done()
    ])

    const test = report.tests[0]!
    expect(test.steps.map((s) => s.id)).toEqual(['seed', 'post'])
    expect(test.steps[0]!.steps.map((s) => s.id)).toEqual(['fetch'])
    // The one that names a step goes under it; the bare one belongs to the test.
    expect(test.steps[1]!.assertions.map((a) => a.type)).toEqual(['status'])
    expect(test.assertions.map((a) => a.type)).toEqual(['equals'])
    expect(report.suites.map((s) => s.name)).toEqual(['suites/pay.yaml'])
  })

  it('takes the totals from the run rather than counting them again', () => {
    // A report that disagreed with the exit code would be the one that is
    // wrong, and there is no reason for two answers to exist.
    const report = fold([
      run(),
      started('a'), finished('a', 'failed', 3),
      done({ status: 'failed', passed: 4, failed: 1, errored: 2, skipped: 3, durationMs: 90 })
    ])

    expect(report.totals).toEqual({ tests: 10, passed: 4, failed: 1, error: 2, skipped: 3 })
    expect(report.status).toBe('failed')
  })

  it('keeps two suites apart when their events interleave', () => {
    // G4: a reporter may see two stories at once, and every event names the
    // test it belongs to. Reading adjacency is the fault already shipped twice.
    const report = fold([
      run(),
      started('a1', { suite: 'a.yaml' }),
      started('b1', { suite: 'b.yaml' }),
      { type: 'step.started', test: 'b1', stepId: 'bs', stepType: 'http', depth: 1 },
      { type: 'step.started', test: 'a1', stepId: 'as', stepType: 'http', depth: 1 },
      { type: 'step.finished', test: 'a1', stepId: 'as', stepType: 'http', depth: 1, status: 'passed', durationMs: 1 },
      { type: 'step.finished', test: 'b1', stepId: 'bs', stepType: 'http', depth: 1, status: 'passed', durationMs: 1 },
      finished('b1', 'passed', 2),
      finished('a1', 'passed', 3),
      done()
    ])

    const byName = new Map(report.tests.map((t) => [t.name, t]))
    expect(byName.get('a1')!.steps.map((s) => s.id)).toEqual(['as'])
    expect(byName.get('b1')!.steps.map((s) => s.id)).toEqual(['bs'])
  })

  it('collects the reasons a test is not green, in the order the run found out', () => {
    const report = fold([
      run(),
      started('one'),
      { type: 'step.started', test: 'one', stepId: 'post', stepType: 'http', depth: 1 },
      {
        type: 'step.finished', test: 'one', stepId: 'post', stepType: 'http', depth: 1,
        status: 'error', durationMs: 5, message: 'ECONNREFUSED', detail: { url: '/orders' }
      },
      { type: 'assertion.evaluated', test: 'one', assertionType: 'status', passed: false, message: 'status is 200', expected: 200, actual: 500 },
      finished('one', 'failed', 6),
      done({ status: 'failed', passed: 0, failed: 1 })
    ])

    const test = report.tests[0]!
    expect(test.failures).toEqual([
      'step post (http): ECONNREFUSED',
      'assertion status: status is 200'
    ])
    // The exchange, not a sentence about it: without `detail` a repair loop
    // reading this has a duration and no body.
    expect(test.steps[0]!.detail).toEqual({ url: '/orders' })
    expect(test.assertions[0]).toMatchObject({ expected: 200, actual: 500 })
  })
})

describe('who owns each word', () => {
  it('reads the running session rather than a table baked in here', () => {
    const capabilities = {
      apiVersion: 1,
      plugins: [],
      stepTypes: [{ name: 'browser.open', plugin: '@speqkit/plugin-playwright', summary: 'opens a page' }],
      assertions: [{ name: 'status', plugin: '@speqkit/plugin-http' }],
      valueProviders: [],
      reporters: [],
      loaders: []
    } as unknown as Capabilities

    // The answer in a project with one more plugin installed has one more
    // entry in it. That is the whole reason it comes from `host.capabilities()`.
    expect(ownersOf(capabilities)).toEqual({
      steps: { 'browser.open': { plugin: '@speqkit/plugin-playwright', summary: 'opens a page' } },
      assertions: { status: { plugin: '@speqkit/plugin-http' } }
    })
  })
})

describe('the page', () => {
  const report = (): HtmlReport =>
    fold([
      run(),
      { type: 'suite.started', suite: 'suites/pay.yaml' },
      started('refund', { suite: 'suites/pay.yaml', tags: ['smoke'] }),
      finished('refund', 'passed', 20),
      done()
    ])

  it('is one file with nothing outside it', () => {
    const html = renderHtml(report(), { title: 'speq run' })

    // The entire argument for this plugin: a report with a fetch in it needs a
    // server, which is why Allure ships `allure serve`, which is a second tool
    // on the reader's machine.
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/)
    expect(html).not.toMatch(/https?:\/\/(?!speqkit)/)
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('cannot be broken out of by a payload the system under test chose', () => {
    const hostile = fold([
      run(),
      started('</script><script>alert(1)</script>'),
      {
        type: 'assertion.evaluated', test: '</script><script>alert(1)</script>',
        assertionType: 'equals', passed: false, message: 'body is right',
        expected: '<!-- -->', actual: '</SCRIPT ><img onerror=alert(2)>'
      },
      finished('</script><script>alert(1)</script>', 'failed', 1),
      done({ status: 'failed', passed: 0, failed: 1 })
    ])

    const html = renderHtml(hostile, { title: 'speq run' })

    // Exactly two of each: the JSON island's own tags and the code's. A third
    // would mean a response body had closed the island and opened a script of
    // its own — and it is the *tag* that matters, not the word `alert`, which
    // is data and stays in the page where a reader can see what came back.
    expect(html.match(/<script/gi)).toHaveLength(2)
    expect(html.match(/<\/script/gi)).toHaveLength(2)
    expect(html).not.toContain('<img onerror')
    // The payload is in there, escaped rather than dropped.
    expect(html).toContain('\\u003c/script\\u003e')
    expect(html).toContain('\\u003cimg onerror')
  })

  it('escapes the title, which is the one thing written into markup directly', () => {
    const html = renderHtml(report(), { title: 'payments <b>nightly</b>' })
    expect(html).toContain('<title>payments &lt;b&gt;nightly&lt;/b&gt;</title>')
  })

  it('round-trips through the island so the page reads what the fold wrote', () => {
    const html = renderHtml(report(), { title: 'speq run' })
    const island = /<script type="application\/json" id="speq-report">([\s\S]*?)<\/script>/.exec(html)![1]!
    // `JSON.parse` is what the page does, and `\u003c` is a legal JSON escape,
    // so the escaping above costs the reader nothing.
    expect(JSON.parse(island).tests[0].name).toBe('refund')
  })
})

describe('artifacts', () => {
  const dirs: string[] = []
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'speq-html-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const withArtifact = (path: string | undefined, bytes: number): HtmlReport =>
    fold([
      run(),
      started('one'),
      {
        type: 'artifact.attached', test: 'one', name: 'home.png',
        contentType: 'image/png', bytes, ...(path ? { path } : {})
      },
      finished('one', 'passed', 1),
      done()
    ])

  it('carries a small artifact inside the page', () => {
    const dir = scratch()
    const file = join(dir, 'home.png')
    writeFileSync(file, 'pretend png')

    const document = withArtifact(file, 11)
    const embedded = embedArtifacts(document, { target: join(dir, 'report.html'), perFile: 1024, budget: 4096 })

    expect(embedded).toMatchObject({ inlined: 1, linked: 0, missing: 0 })
    expect(document.tests[0]!.artifacts[0]!.href!.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('leaves a large one as a link relative to the page, not to this machine', () => {
    const dir = scratch()
    const file = join(dir, 'big.png')
    writeFileSync(file, 'x'.repeat(4096))

    const document = withArtifact(file, 4096)
    const embedded = embedArtifacts(document, { target: join(dir, 'report.html'), perFile: 128, budget: 4096 })

    // An absolute path is right on the machine that produced the report and
    // wrong on every machine that downloads it, which is all of them.
    expect(embedded).toMatchObject({ inlined: 0, linked: 1 })
    expect(document.tests[0]!.artifacts[0]!.href).toBe('big.png')
  })

  it('counts an artifact the run never wrote instead of linking to nothing', () => {
    const document = withArtifact(undefined, 12)
    const embedded = embedArtifacts(document, { target: join(scratch(), 'report.html'), perFile: 1024, budget: 4096 })

    expect(embedded.missing).toBe(1)
    expect(document.tests[0]!.artifacts[0]!.href).toBeUndefined()
  })

  it('stops inlining once the budget is spent', () => {
    const dir = scratch()
    const files = ['a.png', 'b.png'].map((name) => {
      const file = join(dir, name)
      writeFileSync(file, 'y'.repeat(600))
      return file
    })

    const document = fold([
      run(),
      started('one'),
      { type: 'artifact.attached', test: 'one', name: 'a', contentType: 'image/png', bytes: 600, path: files[0] },
      { type: 'artifact.attached', test: 'one', name: 'b', contentType: 'image/png', bytes: 600, path: files[1] },
      finished('one', 'passed', 1),
      done()
    ])
    const embedded = embedArtifacts(document, { target: join(dir, 'report.html'), perFile: 1024, budget: 1000 })

    expect(embedded).toMatchObject({ inlined: 1, linked: 1 })
  })
})

describe('where it lands', () => {
  it('writes to the stable directory, not to this run', () => {
    // A workflow names one fixed path in `upload-artifact` and cannot
    // interpolate a run id it will not learn until the step has finished.
    expect(targetFile({}, { runId: 'r1', outputDir: '/p/reports', runDir: '/p/reports/r1' }))
      .toBe('/p/reports/report.html')
    expect(targetFile({ output: '/tmp/out.html' }, { runId: 'r1', outputDir: '/p/reports' }))
      .toBe('/tmp/out.html')
  })
})
