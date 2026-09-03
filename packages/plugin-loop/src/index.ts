import { definePlugin, type StepDef, type StepRecord } from '@speqkit/plugin-api'

/**
 * The proof that a plugin author is not boxed in.
 *
 * A loop is not a protocol client — it wraps *other* steps, which is the one
 * thing a naive "step type" contract cannot express. It works here because the
 * kernel's executor is re-entrant and handed to plugins as `ctx.runSteps`.
 * Everything else that looked like it would have to be built in — `retry`,
 * `if`, `try/catch` — follows from the same three lines. Everything else
 * sequential, that is: `runSteps` runs one call at a time by design, so
 * `parallel` is not on the list. Concurrency in speq is between suites.
 *
 * This plugin is written against the published API only. If it ever needs a
 * kernel change, the spine is wrong and the change belongs there, not here.
 */
export default definePlugin({
  name: '@speqkit/plugin-loop',
  docs: {
    summary: 'the two shapes of repetition: once per thing, and again until it works',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-loop#readme',
    examples: [
      {
        title: 'once per item',
        summary: '`as` names the current item; without it the binding is `item`.',
        for: ['loop'],
        code: [
          '- type: loop',
          '  over: ${vars:skus}',
          '  as: sku',
          '  steps:',
          '    - type: http',
          '      method: GET',
          '      url: ${base}/products/${sku}',
          '      assert:',
          '        - type: status',
          '          expected: 200'
        ].join('\n')
      },
      {
        title: 'waiting for something that is not ready yet',
        summary:
          'Retry is for a world that has not caught up, not for a flaky check. ' +
          'A step that only passes on the third attempt is saying the system is eventually consistent.',
        for: ['retry'],
        code: [
          '- type: retry',
          '  attempts: 5',
          '  delayMs: 200',
          '  steps:',
          '    - type: http',
          '      method: GET',
          '      url: ${base}/orders/${orderId}',
          '      assert:',
          '        - type: equals',
          '          path: body.status',
          '          expected: settled'
        ].join('\n')
      }
    ]
  },

  setup(ctx) {
    ctx.defineStepType('loop', {
      summary: 'runs its steps once per item of `over`, or `times` times, binding the current one to `as`',
      schema: {
        type: 'object',
        properties: {
          over: {},
          times: { type: 'number' },
          as: { type: 'string' },
          steps: { type: 'array' }
        },
        additionalProperties: false
      },

      /**
       * `over` is usually a template, so what it resolves to is not knowable
       * here — but whether one of the two was written at all is, and that
       * mistake used to surface as an errored step in the middle of a run,
       * from a message that could not say which file it was in.
       */
      validate(step) {
        const over = step.over !== undefined && step.over !== null
        const times = step.times !== undefined
        if (over && times) return ["'over' and 'times' exclude each other; a loop is over a list or a count"]
        if (!over && !times) return ["a loop needs 'over' (a list) or 'times' (a count)"]
        if (times && typeof step.times === 'number' && step.times <= 0) {
          return [{ path: 'times', message: `'times' has to be positive, got ${step.times}` }]
        }
        return []
      },

      async execute(exec, input) {
        const children = (input.steps ?? []) as StepDef[]
        const alias = String(input.as ?? 'item')
        const items = itemsOf(input)

        const iterations: StepRecord[][] = []
        for (const [index, item] of items.entries()) {
          const records = await exec.runSteps(children, {
            vars: { [alias]: item, [`${alias}Index`]: index },
            label: `${alias}=${short(item)}`
          })
          iterations.push(records)
          if (records.some((r) => r.status === 'error' || r.status === 'failed')) break
        }

        return {
          iterations: iterations.length,
          completed: iterations.length === items.length,
          results: iterations
        }
      }
    })

    ctx.defineStepType('retry', {
      summary: 'runs its steps again until they pass, up to `attempts`, waiting `delayMs` between tries',
      schema: {
        type: 'object',
        properties: { attempts: { type: 'number' }, delayMs: { type: 'number' }, steps: { type: 'array' } },
        additionalProperties: false
      },

      validate(step) {
        if (typeof step.attempts === 'number' && step.attempts < 1) {
          return [{ path: 'attempts', message: `'attempts' has to be at least 1, got ${step.attempts}` }]
        }
        return []
      },

      async execute(exec, input) {
        const children = (input.steps ?? []) as StepDef[]
        const attempts = Math.max(1, Number(input.attempts ?? 3))
        const delayMs = Number(input.delayMs ?? 250)

        let last: StepRecord[] = []
        for (let attempt = 1; attempt <= attempts; attempt++) {
          last = await exec.runSteps(children, { vars: { attempt }, label: `attempt ${attempt}` })
          if (!last.some((r) => r.status === 'error' || r.status === 'failed')) {
            return { attempts: attempt, succeeded: true, results: last }
          }
          if (attempt < attempts) await sleep(delayMs, exec.signal)
        }
        throw new Error(`all ${attempts} attempts failed: ${last.find((r) => r.message)?.message ?? 'no detail'}`)
      }
    })
  }
})

function itemsOf(input: Record<string, unknown>): unknown[] {
  if (Array.isArray(input.over)) return input.over
  if (input.over !== undefined && input.over !== null) {
    throw new Error(`'over' must resolve to a list, got ${typeof input.over}`)
  }
  const times = Number(input.times ?? 0)
  if (!Number.isFinite(times) || times <= 0) {
    throw new Error(`loop needs either 'over' (a list) or 'times' (a positive number)`)
  }
  return Array.from({ length: times }, (_, i) => i)
}

function short(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > 24 ? `${text.slice(0, 23)}…` : text
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
