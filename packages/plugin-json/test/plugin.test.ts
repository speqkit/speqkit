import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type TestDef } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import json, { SummaryBuilder, type JsonRun } from '@speqkit/plugin-json'

/**
 * The shape is the deliverable, so the tests are about the shape.
 *
 * Every key the corpus's workflow names in `jq` has a test of its own here,
 * and they are written as the `jq` path rather than as a property access, so
 * that a rename shows up as a test about a contract rather than a test about
 * a field.
 */

let kit: Harness
afterEach(async () => { await kit.close() })

const shop = definePlugin({
  name: 'shop',
  setup(ctx) {
    ctx.defineStepType('ok', { execute: (_e, i) => ({ value: i.value ?? 1 }) })
    ctx.defineStepType('boom', { execute() { throw new Error('the plugin fell over') } })
    ctx.defineAssertion('is', {
      evaluate: (a, i) => ({
        passed: a.last?.value === i.expected,
        message: `expected ${String(i.expected)}, got ${String(a.last?.value)}`
      })
    })
  }
})

async function report(tests: TestDef[], options?: { output?: string }): Promise<JsonRun> {
  kit = await harness(json, { with: [shop], config: { json: { ...options } }, artifacts: true })
  await kit.run(tests, ['json'])
  const at = options?.output ?? join('results', 'summary.json')
  return JSON.parse(readFileSync(join(kit.root, 'reports', at), 'utf8')) as JsonRun
}

describe('the file a workflow reads', () => {
  it('writes reports/results/summary.json without being told to', async () => {
    // The path is not a default we chose freshly; it is where the suite this
    // was designed for already looks.
    const summary = await report([{ name: 't', steps: [{ type: 'ok' }] }])
    expect(summary.status).toBe('passed')
  })

  it('answers .status, .durationMs and .totals.total', async () => {
    const summary = await report([
      { name: 'a', steps: [{ type: 'ok' }] },
      { name: 'b', steps: [{ type: 'ok' }] }
    ])
    expect(summary.status).toBe('passed')
    expect(summary.totals.total).toBe(2)
    expect(typeof summary.durationMs).toBe('number')
  })

  it('counts passed, failed and errored apart', async () => {
    const summary = await report([
      { name: 'a', steps: [{ id: 's', type: 'ok', value: 1 }], assert: [{ type: 'is', expected: 1 }] },
      { name: 'b', steps: [{ id: 's', type: 'ok', value: 1 }], assert: [{ type: 'is', expected: 2 }] },
      { name: 'c', steps: [{ type: 'boom' }] }
    ])

    // `failed` is the system saying no; `error` is never getting an answer.
    // A summary that merges them makes a broken environment look like a
    // broken build, which is the report telling CI the wrong thing to do.
    expect(summary.totals).toMatchObject({ total: 3, passed: 1, failed: 1, errored: 1 })
    expect(summary.status).toBe('error')
  })

  it('answers .totals.pending, under that name', async () => {
    const summary = await report([
      { name: 'a', steps: [{ type: 'ok' }] },
      { name: 'b', pending: 'the stack cannot reach this path', steps: [{ type: 'ok' }] }
    ])

    // The workflow writes `.totals.pending // 0`. Dropping the key would make
    // it report zero pending tests instead of failing — wrong, and silent.
    expect(summary.totals.pending).toBe(1)
    expect(summary.totals.skipped).toBe(1)
  })

  it('keys each test by .id and says what went wrong in .message', async () => {
    const summary = await report([
      { name: 'menu.lists', steps: [{ id: 's', type: 'ok', value: 1 }], assert: [{ type: 'is', expected: 9 }] }
    ])

    // The failure table is `.tests[] | select(.status=="failed") | .id, .message`.
    const failed = summary.tests.filter((t) => t.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.id).toBe('menu.lists')
    expect(failed[0]!.message).toBe('expected 9, got 1')
  })

  it('keeps every reason, not only the first', async () => {
    const summary = await report([
      {
        name: 't',
        steps: [{ id: 's', type: 'ok', value: 1 }],
        assert: [{ type: 'is', expected: 2 }, { type: 'is', expected: 3 }]
      }
    ])
    expect(summary.tests[0]!.messages).toEqual(['expected 2, got 1', 'expected 3, got 1'])
    expect(summary.tests[0]!.message).toBe('expected 2, got 1')
  })

  it('carries the title, the file, the annotations and the pending reason', async () => {
    const summary = await report([{
      name: 'menu.lists',
      title: 'GET /menu lists the categories',
      meta: { owner: 'mira' },
      pending: 'the fixture service is not in the gate yet',
      source: 'suites/menu/lists.yaml',
      steps: [{ type: 'ok' }]
    }])

    expect(summary.tests[0]).toMatchObject({
      id: 'menu.lists',
      title: 'GET /menu lists the categories',
      file: 'suites/menu/lists.yaml',
      meta: { owner: 'mira' },
      pending: 'the fixture service is not in the gate yet',
      status: 'skipped'
    })
  })

  it('goes where it is told to', async () => {
    const summary = await report([{ name: 't', steps: [{ type: 'ok' }] }], { output: 'run.json' })
    expect(summary.totals.total).toBe(1)
  })
})

describe('the stream is enough on its own', () => {
  it('builds the same summary from replayed events as from a run', async () => {
    kit = await harness(json, { with: [shop], artifacts: true })
    const tests = [
      { name: 'a', steps: [{ id: 's', type: 'ok', value: 1 }], assert: [{ type: 'is', expected: 1 }] },
      { name: 'b', pending: 'not yet', steps: [{ type: 'ok' }] }
    ]
    await kit.run(tests, ['json'])
    const written = JSON.parse(
      readFileSync(join(kit.root, 'reports', 'results', 'summary.json'), 'utf8')
    ) as JsonRun

    // Rebuilt from the events the run emitted, with no access to the outcome
    // object. `speq report` re-renders a finished run this way, and a report
    // that cannot be regenerated is a report nobody can check.
    const builder = new SummaryBuilder()
    for (const event of kit.events) builder.on(event)

    expect(builder.result()).toEqual(written)
  })

  it('does not carry one run into the next', async () => {
    const builder = new SummaryBuilder()
    for (const event of [
      { type: 'run.started', runId: 'one', tests: 1, at: 0 },
      { type: 'test.started', test: 'a' },
      { type: 'test.finished', test: 'a', status: 'passed', durationMs: 1 },
      { type: 'run.finished', runId: 'one', status: 'passed', durationMs: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
      { type: 'run.started', runId: 'two', tests: 1, at: 0 },
      { type: 'test.started', test: 'b' },
      { type: 'test.finished', test: 'b', status: 'passed', durationMs: 1 },
      { type: 'run.finished', runId: 'two', status: 'passed', durationMs: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }
    ] as Parameters<SummaryBuilder['on']>[0][]) builder.on(event)

    // One reporter instance sees several runs — a replay after a run, an
    // editor session. Two runs' worth of tests in one file is nobody's intent.
    expect(builder.result().tests.map((t) => t.id)).toEqual(['b'])
  })
})
