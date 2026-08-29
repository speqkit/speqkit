import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type StepRecord } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import loop from '@speqkit/plugin-loop'

/**
 * Written the way a third-party author would write them: against the
 * published API through `@speqkit/test-kit`, with no reference to the kernel's
 * internals. If this file needs anything the kit does not offer, the kit is
 * short of something a plugin author needs.
 */

let kit: Harness
afterEach(async () => { await kit.close() })

/** A body to wrap. `fail` is how a retry is given something to recover from. */
const attempts: number[] = []
const body = definePlugin({
  name: 'body',
  setup(ctx) {
    ctx.defineStepType('echo', { execute: (_e, input) => ({ value: input.value }) })
    ctx.defineStepType('flaky', {
      execute(_e, input) {
        attempts.push(attempts.length + 1)
        if (attempts.length < Number(input.succeedsOn ?? 2)) throw new Error('not yet')
        return { attempt: attempts.length }
      }
    })
  }
})

const results = (records: unknown) => (records as StepRecord[][]).map((r) => r.map((s) => s.result))

describe('loop', () => {
  it('runs the body once per item, with the item bound', async () => {
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({
      type: 'loop', over: ['a', 'b', 'c'], steps: [{ type: 'echo', value: '${item}' }]
    })

    expect(step.status).toBe('passed')
    expect(step.result.iterations).toBe(3)
    expect(step.result.completed).toBe(true)
    expect(results(step.result.results)).toEqual([[{ value: 'a' }], [{ value: 'b' }], [{ value: 'c' }]])
  })

  it('binds the index alongside the item, under the chosen alias', async () => {
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({
      type: 'loop', over: ['x', 'y'], as: 'row',
      steps: [{ type: 'echo', value: '${row}-${rowIndex}' }]
    })

    expect(results(step.result.results)).toEqual([[{ value: 'x-0' }], [{ value: 'y-1' }]])
  })

  it('counts instead of iterating when given `times`', async () => {
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({ type: 'loop', times: 3, steps: [{ type: 'echo', value: '${item}' }] })

    expect(results(step.result.results)).toEqual([[{ value: 0 }], [{ value: 1 }], [{ value: 2 }]])
  })

  it('resolves `over` from an earlier step, so the list can be fetched', async () => {
    kit = await harness(loop, { with: [body] })
    await kit.step({ id: 'fetch', type: 'echo', value: ['one', 'two'] })
    const step = await kit.step({
      type: 'loop', over: '${fetch.value}', steps: [{ type: 'echo', value: '${item}' }]
    })

    expect(step.result.iterations).toBe(2)
  })

  it('stops at the first iteration that fails, and says it did not finish', async () => {
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({
      type: 'loop', over: [1, 2, 3], steps: [{ type: 'nope' }]
    })

    expect(step.result.iterations).toBe(1)
    expect(step.result.completed).toBe(false)
  })

  it('refuses a non-list `over` rather than iterating its characters', async () => {
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({ type: 'loop', over: 'abc', steps: [] })

    expect(step.status).toBe('error')
    expect(step.message).toContain("'over' must resolve to a list")
  })

  it('asks for one of the two inputs when given neither', async () => {
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({ type: 'loop', steps: [] })

    expect(step.message).toContain("either 'over' (a list) or 'times'")
  })

  it('does not leak the loop variable to the step after it', async () => {
    kit = await harness(loop, { with: [body] })
    await kit.step({ type: 'loop', over: ['a'], steps: [{ type: 'echo', value: '${item}' }] })
    const after = await kit.step({ type: 'echo', value: '${item}' })

    expect(after.status).toBe('error')
    expect(after.message).toContain("'item' is not defined")
  })

  it('rejects an input the schema does not allow', async () => {
    kit = await harness(loop, { with: [body] })
    const diagnostics = kit.validate([
      { name: 't', steps: [{ type: 'loop', times: 1, whle: true, steps: [] }], source: 'a.yaml' }
    ])

    expect(diagnostics[0]!.message).toContain('whle')
  })
})

describe('retry', () => {
  it('gives up the moment the body succeeds', async () => {
    attempts.length = 0
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({
      type: 'retry', attempts: 5, delayMs: 0, steps: [{ type: 'flaky', succeedsOn: 3 }]
    })

    expect(step.status).toBe('passed')
    expect(step.result).toMatchObject({ attempts: 3, succeeded: true })
  })

  it('binds the attempt number for the body to see', async () => {
    attempts.length = 0
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({
      type: 'retry', attempts: 2, delayMs: 0, steps: [{ type: 'echo', value: '${attempt}' }]
    })

    // `retry` reports one flat list of records; `loop` reports one per
    // iteration. Different shapes, because they nest differently.
    expect((step.result.results as StepRecord[]).map((r) => r.result)).toEqual([{ value: 1 }])
  })

  it('errors after the last attempt, carrying the failure that caused it', async () => {
    attempts.length = 0
    kit = await harness(loop, { with: [body] })
    const step = await kit.step({
      type: 'retry', attempts: 2, delayMs: 0, steps: [{ type: 'flaky', succeedsOn: 99 }]
    })

    expect(step.status).toBe('error')
    expect(step.message).toBe('all 2 attempts failed: not yet')
    expect(attempts).toHaveLength(2)
  })
})

describe('the two compose, which is the point of both', () => {
  it('retries inside a loop without either knowing about the other', async () => {
    attempts.length = 0
    kit = await harness(loop, { with: [body] })
    const outcome = await kit.run([
      {
        name: 'retries each item',
        steps: [{
          id: 'l',
          type: 'loop',
          over: ['a', 'b'],
          steps: [{ type: 'retry', attempts: 3, delayMs: 0, steps: [{ type: 'flaky', succeedsOn: 2 }] }]
        }]
      }
    ])

    expect(outcome.status).toBe('passed')
    expect(outcome.tests[0]!.steps[0]!.result.iterations).toBe(2)
    // Two iterations, three executions: the first item failed once.
    expect(attempts).toHaveLength(3)
  })
})
