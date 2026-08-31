import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@speqkit/plugin-api'
import { RunBuilder, renderJUnit } from '@speqkit/plugin-junit'

/**
 * The fold from events to XML, on a plain list of events.
 *
 * This is the plugin that carries the claim the whole reporter contract rests
 * on: every number in the file is folded out of the stream, with no access to
 * the runner's result object. Testing it on a hand-written stream is the only
 * way to state that — a run would supply both, and prove nothing about which
 * one was read.
 *
 * `packages/core/test/reporting.test.ts` already drives it through a real run,
 * for the parts that need one: failure against error, the output path, and the
 * control characters that would make the file unparseable.
 */

function fold(events: RunEvent[]): string {
  const builder = new RunBuilder()
  for (const event of events) builder.on(event)
  return renderJUnit(builder.result(), { name: 'speq' })
}

const started = (test: string, source?: string): RunEvent =>
  ({ type: 'test.started', test, ...(source ? { source } : {}) })
const finished = (test: string, status: 'passed' | 'failed' | 'error' | 'skipped', durationMs: number): RunEvent =>
  ({ type: 'test.finished', test, status, durationMs })

describe('the fold', () => {
  it('groups cases under the suite that bracketed them', () => {
    const xml = fold([
      { type: 'run.started', runId: 'r1', tests: 3, at: 0 },
      { type: 'suite.started', suite: 'suites/orders.yaml' },
      started('orders.list', 'suites/orders.yaml'), finished('orders.list', 'passed', 10),
      started('orders.create', 'suites/orders.yaml'), finished('orders.create', 'failed', 20),
      { type: 'suite.finished', suite: 'suites/orders.yaml' },
      { type: 'suite.started', suite: 'suites/health.yaml' },
      started('health', 'suites/health.yaml'), finished('health', 'passed', 5),
      { type: 'suite.finished', suite: 'suites/health.yaml' },
      { type: 'run.finished', runId: 'r1', status: 'failed', passed: 2, failed: 1, errored: 0, skipped: 0, durationMs: 40 }
    ])

    // A test does not carry its suite on the event; the bracketing does. That
    // is what has to keep holding on replay, where the only thing preserved is
    // the order.
    expect(xml).toContain('<testsuite name="suites/orders.yaml" tests="2" failures="1" errors="0" skipped="0"')
    expect(xml).toContain('<testsuite name="suites/health.yaml" tests="1" failures="0" errors="0" skipped="0"')
    expect(xml).toContain('classname="suites/orders.yaml"')
    expect(xml).toContain('file="suites/health.yaml"')
  })

  it('counts the whole run on testsuites and each suite on its own', () => {
    const xml = fold([
      { type: 'run.started', runId: 'r1', tests: 3, at: 0 },
      { type: 'suite.started', suite: 'a.yaml' },
      started('one'), finished('one', 'error', 1000),
      started('two'), { type: 'test.skipped', test: 'two', reason: 'the 429 path needs a limiter' },
      finished('two', 'skipped', 0),
      { type: 'suite.finished', suite: 'a.yaml' },
      { type: 'run.finished', runId: 'r1', status: 'error', passed: 0, failed: 0, errored: 1, skipped: 1, durationMs: 1500 }
    ])

    expect(xml).toContain('tests="2" failures="0" errors="1" skipped="1" time="1.500"')
    expect(xml).toContain('<skipped/>')
    // Seconds, three places: what every CI reading this file expects.
    expect(xml).toContain('time="1.000"')
  })

  it('puts an attachment where a CI viewer looks for one', () => {
    const xml = fold([
      { type: 'run.started', runId: 'r1', tests: 1, at: 0 },
      { type: 'suite.started', suite: 'ui.yaml' },
      started('the page loads'),
      { type: 'artifact.attached', test: 'the page loads', name: 'home.png', contentType: 'image/png', bytes: 12, path: 'reports/r1/home.png' },
      finished('the page loads', 'passed', 3),
      { type: 'suite.finished', suite: 'ui.yaml' },
      { type: 'run.finished', runId: 'r1', status: 'passed', passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 3 }
    ])

    expect(xml).toContain('<system-out>[[ATTACHMENT|reports/r1/home.png]]</system-out>')
  })

  it('says which assertion failed, not just that the test did', () => {
    const xml = fold([
      { type: 'run.started', runId: 'r1', tests: 1, at: 0 },
      { type: 'suite.started', suite: 'a.yaml' },
      started('orders.create'),
      { type: 'assertion.evaluated', test: 'orders.create', assertionType: 'status', passed: false, message: 'expected 201, got 500', expected: 201, actual: 500 },
      finished('orders.create', 'failed', 8),
      { type: 'suite.finished', suite: 'a.yaml' },
      { type: 'run.finished', runId: 'r1', status: 'failed', passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 8 }
    ])

    expect(xml).toContain('<failure message="assertion status: expected 201, got 500" type="failed">')
  })

  it("does not carry one run's cases into the next", () => {
    const builder = new RunBuilder()
    const run = (id: string, name: string): RunEvent[] => [
      { type: 'run.started', runId: id, tests: 1, at: 0 },
      { type: 'suite.started', suite: 'a.yaml' },
      started(name), finished(name, 'passed', 1),
      { type: 'suite.finished', suite: 'a.yaml' },
      { type: 'run.finished', runId: id, status: 'passed', passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 1 }
    ]

    // One reporter, several runs in a process: `speq report` replaying after a
    // run, or an editor session that never exits.
    for (const event of run('r1', 'first')) builder.on(event)
    for (const event of run('r2', 'second')) builder.on(event)

    const xml = renderJUnit(builder.result(), { name: 'speq' })
    expect(xml).toContain('tests="1"')
    expect(xml).toContain('name="second"')
    expect(xml).not.toContain('name="first"')
  })
})

describe('an interleaved stream', () => {
  /**
   * The same run, told twice: once as one suite after another, once as two
   * suites overlapping. G4 permits the second, so the file has to come out the
   * same — and it did not. The builder held one open case and one suite name,
   * so `orders.create` overwrote `health` and the file listed one of the two.
   */
  const sequential: RunEvent[] = [
    { type: 'run.started', runId: 'r1', tests: 2, at: 0 },
    { type: 'suite.started', suite: 'suites/orders.yaml' },
    started('orders.create', 'suites/orders.yaml'),
    { type: 'step.finished', test: 'orders.create', stepType: 'http', depth: 1, status: 'failed', durationMs: 4, message: 'expected 201' },
    finished('orders.create', 'failed', 20),
    { type: 'suite.finished', suite: 'suites/orders.yaml' },
    { type: 'suite.started', suite: 'suites/health.yaml' },
    started('health', 'suites/health.yaml'),
    { type: 'artifact.attached', test: 'health', name: 'body.json', contentType: 'application/json', bytes: 12, path: 'a/body.json' },
    finished('health', 'passed', 5),
    { type: 'suite.finished', suite: 'suites/health.yaml' },
    { type: 'run.finished', runId: 'r1', status: 'failed', passed: 1, failed: 1, errored: 0, skipped: 0, durationMs: 25 }
  ]

  const interleaved: RunEvent[] = [
    { type: 'run.started', runId: 'r1', tests: 2, at: 0 },
    { type: 'suite.started', suite: 'suites/orders.yaml' },
    { type: 'suite.started', suite: 'suites/health.yaml' },
    started('orders.create', 'suites/orders.yaml'),
    started('health', 'suites/health.yaml'),
    { type: 'artifact.attached', test: 'health', name: 'body.json', contentType: 'application/json', bytes: 12, path: 'a/body.json' },
    { type: 'step.finished', test: 'orders.create', stepType: 'http', depth: 1, status: 'failed', durationMs: 4, message: 'expected 201' },
    finished('health', 'passed', 5),
    { type: 'suite.finished', suite: 'suites/health.yaml' },
    finished('orders.create', 'failed', 20),
    { type: 'suite.finished', suite: 'suites/orders.yaml' },
    { type: 'run.finished', runId: 'r1', status: 'failed', passed: 1, failed: 1, errored: 0, skipped: 0, durationMs: 25 }
  ]

  it('renders the same file as the sequential one', () => {
    expect(fold(interleaved)).toBe(fold(sequential))
  })

  it('keeps every test, and puts each one under its own suite', () => {
    const xml = fold(interleaved)
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('name="orders.create" classname="suites/orders.yaml"')
    expect(xml).toContain('name="health" classname="suites/health.yaml"')
    expect(xml).toContain('expected 201')
    expect(xml).toContain('[[ATTACHMENT|a/body.json]]')
  })
})

describe('a tree of suites', () => {
  it('writes no element for the ones that hold no cases', () => {
    const xml = fold([
      { type: 'run.started', runId: 'r1', tests: 1, at: 0 },
      { type: 'suite.started', suite: 'suites', title: 'Everything' },
      { type: 'suite.started', suite: 'suites/menu', parent: 'suites' },
      { type: 'suite.started', suite: 'suites/menu/items.yaml', parent: 'suites/menu' },
      started('items', 'suites/menu/items.yaml'), finished('items', 'passed', 10),
      { type: 'suite.finished', suite: 'suites/menu/items.yaml' },
      { type: 'suite.finished', suite: 'suites/menu' },
      { type: 'suite.finished', suite: 'suites' },
      { type: 'run.finished', runId: 'r1', status: 'passed', passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 10 }
    ])

    // Suites nest, and the ones in the middle hold files rather than tests.
    // An empty `<testsuite>` is not a JUnit concept, and a CI viewer showing
    // three suites for one test is a viewer nobody trusts twice.
    expect(xml).toContain('<testsuite name="suites/menu/items.yaml"')
    expect(xml).not.toContain('<testsuite name="suites"')
    expect(xml).not.toContain('<testsuite name="suites/menu"')
    expect(xml).toContain('tests="1"')
  })

  it('ignores the steps that belong to a suite rather than a test', () => {
    const xml = fold([
      { type: 'run.started', runId: 'r1', tests: 1, at: 0 },
      { type: 'suite.started', suite: 'suites/menu' },
      { type: 'step.started', suite: 'suites/menu', stepType: 'http', depth: 1, phase: 'setup' },
      { type: 'step.finished', suite: 'suites/menu', stepType: 'http', depth: 1, phase: 'setup', status: 'failed', durationMs: 5, message: 'staging is down' },
      { type: 'suite.started', suite: 'suites/menu/items.yaml', parent: 'suites/menu' },
      started('items', 'suites/menu/items.yaml'), finished('items', 'error', 0),
      { type: 'suite.finished', suite: 'suites/menu/items.yaml' },
      { type: 'suite.finished', suite: 'suites/menu' },
      { type: 'run.finished', runId: 'r1', status: 'error', passed: 0, failed: 0, errored: 1, skipped: 0, durationMs: 10 }
    ])

    // A step with no test names its suite instead, and JUnit has nowhere to
    // put it. Nothing is lost: a suite whose setup failed is a suite whose
    // every test is an errored case here.
    expect(xml).toContain('errors="1"')
    expect(xml).not.toContain('staging is down')
  })
})
