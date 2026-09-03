import type { AssertOutcome, RunEvent, EventListener, StepStatus } from '@speqkit/plugin-api'

/** The one channel every surface — CLI, TUI, VS Code, reporters — listens on. */
export class EventBus {
  #listeners: EventListener[] = []

  subscribe(listener: EventListener): () => void {
    this.#listeners.push(listener)
    return () => {
      const i = this.#listeners.indexOf(listener)
      if (i >= 0) this.#listeners.splice(i, 1)
    }
  }

  emit(event: RunEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (err) {
        // A broken reporter must never take the run down with it.
        process.stderr.write(`speq: reporter threw on ${event.type}: ${String(err)}\n`)
      }
    }
  }
}

/**
 * The values behind a failed assertion, on their way into the event stream.
 *
 * Only on failure, and only the keys the assertion actually set. A check that
 * has nothing to compare — `visible`, `schema` — says so by leaving both
 * undefined, and an event with `expected: undefined` in it is a reporter
 * printing "expected undefined" at somebody.
 */
export function comparison(outcome: AssertOutcome): { expected?: unknown; actual?: unknown } {
  if (outcome.passed) return {}
  return {
    ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
    ...(outcome.actual !== undefined ? { actual: outcome.actual } : {})
  }
}

/**
 * What a step recorded about itself, on its way into the event stream.
 *
 * The same rule `comparison` follows, and it is the rule that lets this exist
 * at all: only when the step did not pass. A run where everything passes
 * writes exactly the log it wrote before this field existed, so the cost of
 * carrying an exchange is paid by the runs that have something to explain.
 */
export function recorded(status: StepStatus, detail: unknown): { detail?: unknown } {
  if (status === 'passed' || detail === undefined) return {}
  return { detail }
}
