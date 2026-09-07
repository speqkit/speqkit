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
    summary: 'repetition, and its absence: once per thing, again until it works, or simply waiting',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-loop#readme',
    examples: [
      {
        title: 'time that has to pass',
        summary:
          'For what nothing can be asked about — a queue that delivers, a token that starts working. ' +
          'When there is something to ask, `retry` is the shorter wait.',
        for: ['wait'],
        code: [
          '- type: wait',
          '  ms: 500'
        ].join('\n')
      },
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
          over: { description: 'the list to run once per item — usually `${a.body.items}`; excludes `times`' },
          times: { type: 'integer', minimum: 1, description: 'how many times to run the steps; excludes `over`' },
          as: { type: 'string', description: 'the name the body reads the current item under; `item` by default, with `<as>Index` beside it' },
          steps: { type: 'array', description: 'the body, run in a child scope that is popped when the loop ends' }
        },
        required: ['steps'],
        additionalProperties: false
      },

      /**
       * `over` is usually a template, so what it resolves to is not knowable
       * here — but whether one of the two was written at all is, and that
       * mistake used to surface as an errored step in the middle of a run,
       * from a message that could not say which file it was in.
       */
      /**
       * What the body may read that the test outside cannot: the current
       * item under `as`, and its index under `<as>Index`. Declared so that
       * `speq validate` reads a `${skuu}` in the body as the typo it is
       * rather than as a name some plugin might bind.
       */
      binds: (step) => {
        const alias = typeof step.as === 'string' ? step.as : 'item'
        return [alias, `${alias}Index`]
      },

      validate(step) {
        const over = step.over !== undefined && step.over !== null
        const times = step.times !== undefined
        if (over && times) return ["'over' and 'times' exclude each other; a loop is over a list or a count"]
        if (!over && !times) return ["a loop needs 'over' (a list) or 'times' (a count)"]
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
        properties: {
          attempts: { type: 'integer', minimum: 1, description: 'the most times the steps run; 3 by default' },
          delayMs: { type: 'number', minimum: 0, description: 'the wait between tries, in milliseconds; 0 by default' },
          steps: { type: 'array', description: 'the steps to run again until every one of them passes' }
        },
        required: ['steps'],
        additionalProperties: false
      },

      /** A retry binds nothing new; its body reads exactly what the test does. */
      binds: () => [],


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

    /**
     * The third shape of repetition, which is none: waiting.
     *
     * `retry` is the right answer nearly every time — it asks again until the
     * answer changes, and it stops as soon as it does. This is for the case
     * `retry` cannot express, where there is nothing to ask: a webhook that a
     * queue delivers, a token that is only valid a second from now, a rate
     * limiter that has to be let go of. Before it, the only way to write a
     * pause was a step type in a plugin of one's own, and every project that
     * needed one wrote it.
     *
     * It answers the abort signal rather than holding the process: a run that
     * is being torn down should not wait out somebody's `ms: 30000`.
     */
    ctx.defineStepType('wait', {
      summary: 'does nothing for `ms` milliseconds — for time that has to pass, not for an answer that has to change',
      schema: {
        type: 'object',
        properties: {
          ms: {
            type: 'integer',
            minimum: 0,
            description: 'how long to wait, in milliseconds; a wait longer than the step timeout needs `timeout:` beside it'
          }
        },
        required: ['ms'],
        additionalProperties: false
      },

      /**
       * The one mistake this step type can make on somebody's behalf: a wait
       * longer than the budget the step is given, which arrives as
       * `step-timeout` in the middle of a run and reads like a bug in the
       * system under test. The step's own `timeout` is visible here, so it is
       * a sentence before the run instead.
       */
      validate(step) {
        const ms = typeof step.ms === 'number' ? step.ms : 0
        if (ms > DEFAULT_STEP_TIMEOUT_MS && step.timeout === undefined) {
          return [
            `waiting ${ms}ms will hit the ${DEFAULT_STEP_TIMEOUT_MS}ms step timeout first; ` +
              `write 'timeout: ${ms + 1000}' beside it, or wait for the thing instead with 'retry'`
          ]
        }
        return []
      },

      execute: async (exec, input) => {
        const ms = Number(input.ms)
        const started = Date.now()
        await sleep(ms, exec.signal)
        return { waitedMs: Date.now() - started }
      }
    })
  }
})

/**
 * The kernel's own default, repeated here because a plugin cannot ask for it.
 *
 * Repeating a number is worse than reading it, and the alternative was worse
 * still: a `defaultTimeoutMs` on `ExecContext` would put a kernel setting on
 * the contract so that one step type could write a better sentence.
 */
const DEFAULT_STEP_TIMEOUT_MS = 30_000

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
