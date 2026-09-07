import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '@speqkit/plugin-api'
import {
  RunBuilder, extensionOf, hash, properties, statusOf, writeBundle,
  type AllureBundle, type AllureResult, type AllureStep
} from '@speqkit/plugin-allure'

/**
 * The fold from events to Allure's files, on a plain list of events.
 *
 * The same argument `packages/plugin-junit/test/build.test.ts` makes: a run
 * would supply both the stream and the runner's own result object, and prove
 * nothing about which one was read. A hand-written stream can only be read one
 * way.
 *
 * The clock is injected so a result file has timestamps a test can name. It
 * ticks one millisecond per reading, which is enough to tell "in order" from
 * "all at once" and small enough that every number below is written out.
 */
function fold(events: RunEvent[]): AllureBundle {
  let tick = 0
  const builder = new RunBuilder({ now: () => tick++ })
  for (const event of events) builder.on(event)
  return builder.result()
}

const run = (at = 1_000_000): RunEvent => ({ type: 'run.started', runId: 'r1', tests: 1, at })
const done = (status: 'passed' | 'failed' = 'passed'): RunEvent =>
  ({ type: 'run.finished', runId: 'r1', status, passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 10 })
const started = (test: string, extra: Partial<Extract<RunEvent, { type: 'test.started' }>> = {}): RunEvent =>
  ({ type: 'test.started', test, ...extra })
const finished = (
  test: string,
  status: 'passed' | 'failed' | 'error' | 'skipped',
  durationMs: number
): RunEvent => ({ type: 'test.finished', test, status, durationMs })

const only = (bundle: AllureBundle): AllureResult => {
  expect(bundle.results).toHaveLength(1)
  return bundle.results[0]!
}

describe('what a test becomes', () => {
  it('carries the suite, the tags and the file as labels Allure groups on', () => {
    const result = only(
      fold([
        run(),
        { type: 'suite.started', suite: 'suites/pay.yaml' },
        started('refund lands', {
          suite: 'suites/pay.yaml',
          source: 'suites/pay.yaml',
          tags: ['smoke', 'PAY-114'],
          group: 'visa'
        }),
        finished('refund lands', 'passed', 40),
        { type: 'suite.finished', suite: 'suites/pay.yaml' },
        done()
      ])
    )

    expect(result.labels).toContainEqual({ name: 'framework', value: 'speqkit' })
    expect(result.labels).toContainEqual({ name: 'suite', value: 'suites/pay.yaml' })
    expect(result.labels).toContainEqual({ name: 'tag', value: 'PAY-114' })
    // The `cases` row. Allure has no word for one, and `subSuite` is what
    // gathers a parametrised set under a single heading.
    expect(result.labels).toContainEqual({ name: 'subSuite', value: 'visa' })
    expect(result.fullName).toBe('suites/pay.yaml#refund lands')
  })

  it('promotes the meta keys Allure knows and keeps the rest as parameters', () => {
    const result = only(
      fold([
        run(),
        started('one', { meta: { owner: 'mira', severity: 'critical', swimlane: 'blue', ticket: 7 } }),
        finished('one', 'passed', 1),
        done()
      ])
    )

    expect(result.labels).toContainEqual({ name: 'owner', value: 'mira' })
    expect(result.labels).toContainEqual({ name: 'severity', value: 'critical' })
    // The point of the parameters: a key nobody taught this plugin about is
    // still in the report. A reporter that understands only its own six words
    // throws a team's own annotations away without saying so.
    expect(result.parameters).toContainEqual({ name: 'swimlane', value: 'blue' })
    expect(result.parameters).toContainEqual({ name: 'ticket', value: '7' })
    expect(result.parameters.map((p) => p.name)).not.toContain('owner')
  })

  it('turns issue, tms and links into links a reader can click', () => {
    const result = only(
      fold([
        run(),
        started('one', {
          meta: {
            issue: 'https://tracker.example.com/PAY-114',
            tms: [{ name: 'TC-9', url: 'https://tms.example.com/9' }]
          }
        }),
        finished('one', 'passed', 1),
        done()
      ])
    )

    expect(result.links).toEqual([
      { name: 'https://tracker.example.com/PAY-114', url: 'https://tracker.example.com/PAY-114', type: 'issue' },
      { name: 'TC-9', url: 'https://tms.example.com/9', type: 'tms' }
    ])
  })

  it('gives the same test the same history id across runs, and two tests different ones', () => {
    const one = only(fold([run(1), started('a', { suite: 's.yaml' }), finished('a', 'passed', 1), done()]))
    const again = only(fold([run(2), started('a', { suite: 's.yaml' }), finished('a', 'failed', 9), done()]))
    const other = only(fold([run(1), started('b', { suite: 's.yaml' }), finished('b', 'passed', 1), done()]))

    // The whole trend hangs off this: an id that moved between runs would make
    // every test new every time, and Allure would have nothing to draw.
    expect(again.historyId).toBe(one.historyId)
    expect(other.historyId).not.toBe(one.historyId)
  })
})

describe('the four statuses', () => {
  it('keeps failed and error apart, as failed and broken', () => {
    // The distinction the whole spine rests on: `failed` is the system under
    // test saying no, `error` is never getting an answer. Reporting both as
    // failures is what makes a flaky environment look like a broken build.
    expect(statusOf('failed')).toBe('failed')
    expect(statusOf('error')).toBe('broken')
    expect(statusOf('passed')).toBe('passed')
    expect(statusOf('skipped')).toBe('skipped')
  })

  it('carries the reason a skipped test gives', () => {
    const result = only(
      fold([
        run(),
        started('one'),
        { type: 'test.skipped', test: 'one', reason: 'the 429 path needs a limiter' },
        finished('one', 'skipped', 0),
        done()
      ])
    )

    expect(result.status).toBe('skipped')
    expect(result.statusDetails?.message).toBe('the 429 path needs a limiter')
  })
})

describe('steps', () => {
  const nested: RunEvent[] = [
    run(),
    started('one'),
    { type: 'step.started', test: 'one', stepId: 'seed', stepType: 'loop', depth: 1 },
    { type: 'step.started', test: 'one', stepId: 'fetch', stepType: 'http', parentId: 'seed', depth: 2 },
    {
      type: 'step.finished', test: 'one', stepId: 'fetch', stepType: 'http', parentId: 'seed',
      depth: 2, status: 'passed', durationMs: 7
    },
    { type: 'step.finished', test: 'one', stepId: 'seed', stepType: 'loop', depth: 1, status: 'passed', durationMs: 9 },
    finished('one', 'passed', 12),
    done()
  ]

  it('nests a child step inside the step that opened it', () => {
    const result = only(fold(nested))

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.name).toBe('seed (loop)')
    expect(result.steps[0]!.steps.map((s: AllureStep) => s.name)).toEqual(['fetch (http)'])
  })

  it('hangs an assertion under the step it names, and a bare one on the test', () => {
    const result = only(
      fold([
        run(),
        started('one'),
        { type: 'step.started', test: 'one', stepId: 'post', stepType: 'http', depth: 1 },
        { type: 'step.finished', test: 'one', stepId: 'post', stepType: 'http', depth: 1, status: 'passed', durationMs: 4 },
        { type: 'assertion.evaluated', test: 'one', assertionType: 'status', passed: true, message: 'status is 200', stepId: 'post' },
        { type: 'assertion.evaluated', test: 'one', assertionType: 'equals', passed: true, message: 'body.id is 1' },
        finished('one', 'passed', 5),
        done()
      ])
    )

    expect(result.steps.map((s: AllureStep) => s.name)).toEqual(['post (http)', 'body.id is 1'])
    expect(result.steps[0]!.steps.map((s: AllureStep) => s.name)).toEqual(['status is 200'])
  })

  it('puts the values on a failing assertion, where a reader opens the test to find them', () => {
    const result = only(
      fold([
        run(),
        started('one'),
        {
          type: 'assertion.evaluated', test: 'one', assertionType: 'equals', passed: false,
          message: 'body.id is 1', expected: 1, actual: 2
        },
        finished('one', 'failed', 5),
        done('failed')
      ])
    )

    const step = result.steps[0]!
    expect(step.status).toBe('failed')
    expect(step.parameters).toEqual([
      { name: 'expected', value: '1' },
      { name: 'actual', value: '2' }
    ])
    // And on the test itself, because the report's list view shows this line
    // and nothing else until somebody clicks.
    expect(result.status).toBe('failed')
    expect(result.statusDetails?.message).toBe('equals: body.id is 1')
    expect(result.statusDetails?.trace).toContain('expected: 1')
  })

  it('holds a suite step with no test on the suite container', () => {
    // The one thing JUnit cannot be told: a suite's own setup has no test to
    // belong to, so `plugin-junit` drops it. Allure has `befores`, so it does
    // not have to be dropped.
    const bundle = fold([
      run(),
      { type: 'suite.started', suite: 'suites/pay.yaml' },
      { type: 'step.started', suite: 'suites/pay.yaml', stepType: 'http', depth: 1, phase: 'setup' },
      {
        type: 'step.finished', suite: 'suites/pay.yaml', stepType: 'http', depth: 1,
        phase: 'setup', status: 'passed', durationMs: 3
      },
      started('one', { suite: 'suites/pay.yaml' }),
      finished('one', 'passed', 1),
      { type: 'suite.finished', suite: 'suites/pay.yaml' },
      done()
    ])

    const suite = bundle.containers.find((c) => c.name === 'suites/pay.yaml')
    expect(suite?.befores.map((s) => s.name)).toEqual(['http'])
  })
})

describe('two suites at once', () => {
  it('keeps the steps of each test with that test, whatever order the events arrive in', () => {
    // G4 says a reporter sees each suite's story in order and may see two
    // stories interleaved. Reading adjacency instead of the `test` field on
    // each event is the fault this repository has already shipped twice.
    const bundle = fold([
      run(),
      { type: 'suite.started', suite: 'a.yaml' },
      { type: 'suite.started', suite: 'b.yaml' },
      started('a1', { suite: 'a.yaml' }),
      started('b1', { suite: 'b.yaml' }),
      { type: 'step.started', test: 'b1', stepId: 'bstep', stepType: 'http', depth: 1 },
      { type: 'step.started', test: 'a1', stepId: 'astep', stepType: 'http', depth: 1 },
      { type: 'step.finished', test: 'a1', stepId: 'astep', stepType: 'http', depth: 1, status: 'passed', durationMs: 1 },
      { type: 'step.finished', test: 'b1', stepId: 'bstep', stepType: 'http', depth: 1, status: 'passed', durationMs: 1 },
      finished('b1', 'passed', 2),
      finished('a1', 'passed', 3),
      done()
    ])

    const byName = new Map(bundle.results.map((r) => [r.name, r]))
    expect(byName.get('a1')!.steps.map((s) => s.name)).toEqual(['astep (http)'])
    expect(byName.get('b1')!.steps.map((s) => s.name)).toEqual(['bstep (http)'])
  })
})

describe('time, which the stream nearly does not carry', () => {
  it('takes every duration from the run, and never puts a test before it', () => {
    const bundle = fold([
      run(1_700_000_000_000),
      started('one'),
      { type: 'step.started', test: 'one', stepId: 'post', stepType: 'http', depth: 1 },
      { type: 'step.finished', test: 'one', stepId: 'post', stepType: 'http', depth: 1, status: 'passed', durationMs: 90 },
      finished('one', 'passed', 250),
      done()
    ])

    const result = bundle.results[0]!
    // The duration is the run's answer; the clock only decides where things
    // sit relative to each other. A replay, where the clock says nothing at
    // all, still gets 250ms and 90ms.
    expect(result.stop - result.start).toBe(250)
    expect(result.steps[0]!.stop - result.steps[0]!.start).toBe(90)
    // Laid out forwards from the start, never backwards from the finish:
    // `start = stop - durationMs` put a replayed test before the run that
    // contained it, and Allure's timeline drew it exactly that way.
    expect(result.start).toBeGreaterThanOrEqual(1_700_000_000_000)
  })
})

describe('attachments', () => {
  it('names the copy by the extension a viewer picks the renderer from', () => {
    // Allure decides between "picture" and "download this file" on the
    // extension, not on the content type. A screenshot copied in without one
    // is the single thing anybody attaches an artifact for, rendered as a link.
    expect(extensionOf('/r/1/artifacts/t/home.png', 'image/png')).toBe('.png')
    expect(extensionOf('/r/1/artifacts/t/home', 'image/png')).toBe('.png')
    expect(extensionOf('/r/1/artifacts/t/body', 'application/json')).toBe('.json')
    expect(extensionOf('/r/1/artifacts/t/body', 'application/x-unheard-of')).toBe('.txt')
  })

  it('skips an artifact the run never wrote, rather than pointing at nothing', () => {
    // With no report directory the event carries a byte count and no bytes.
    // There is nothing to copy, and a broken link in the report would be worse
    // than an absence.
    const result = only(
      fold([
        run(),
        started('one'),
        { type: 'artifact.attached', test: 'one', name: 'home.png', contentType: 'image/png', bytes: 12 },
        finished('one', 'passed', 1),
        done()
      ])
    )

    expect(result.attachments).toEqual([])
  })
})

describe('what lands on disk', () => {
  const dirs: string[] = []
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'speq-allure-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('writes a result per test and copies the attachments beside them', () => {
    const source = join(scratch(), 'home.png')
    writeFileSync(source, 'not really a png')

    const bundle = fold([
      run(),
      started('one'),
      { type: 'artifact.attached', test: 'one', name: 'home.png', contentType: 'image/png', bytes: 16, path: source },
      finished('one', 'passed', 1),
      done()
    ])

    const dir = scratch()
    const report = writeBundle(bundle, { dir, environment: { branch: 'main' } })
    const names = readdirSync(dir)

    expect(report.results).toBe(1)
    expect(report.missing).toEqual([])
    expect(names.filter((n) => n.endsWith('-result.json'))).toHaveLength(1)
    expect(names.filter((n) => n.endsWith('-attachment.png'))).toHaveLength(1)
    expect(readFileSync(join(dir, 'environment.properties'), 'utf8')).toContain('branch=main')
  })

  it('reports a missing attachment instead of failing the run over it', () => {
    const bundle = fold([
      run(),
      started('one'),
      {
        type: 'artifact.attached', test: 'one', name: 'gone.png', contentType: 'image/png',
        bytes: 3, path: '/no/such/file.png'
      },
      finished('one', 'passed', 1),
      done()
    ])

    const report = writeBundle(bundle, { dir: scratch() })
    expect(report.missing).toEqual(['/no/such/file.png'])
    expect(report.results).toBe(1)
  })

  it('cleans only files it could have written itself', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'aaa-result.json'), '{}')
    writeFileSync(join(dir, 'history-trend.json'), '[]')
    writeFileSync(join(dir, 'NOTES.md'), 'somebody put this here')

    writeBundle(fold([run(), started('one'), finished('one', 'passed', 1), done()]), { dir, clean: true })
    const names = readdirSync(dir)

    // The directory is a path out of somebody's config file. `rm -rf` on one of
    // those is not a thing this plugin does, so the sweep is by pattern and a
    // stray file survives it.
    expect(names).toContain('NOTES.md')
    expect(names).toContain('history-trend.json')
    expect(names).not.toContain('aaa-result.json')
  })

  it('escapes a properties value the way java.util.Properties reads it back', () => {
    // A base URL with a port in it has both a colon and an equals-adjacent
    // shape, and it is the first thing anybody puts in this panel.
    expect(properties({ 'base url': 'http://localhost:8080' })).toBe(
      'base\\ url=http://localhost:8080\n'
    )
  })
})

describe('the id', () => {
  it('is stable, and different for different names', () => {
    expect(hash('a')).toBe(hash('a'))
    expect(hash('a')).not.toBe(hash('b'))
    expect(hash('a')).toMatch(/^[0-9a-f]{16}$/)
  })
})
