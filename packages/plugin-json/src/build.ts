import type { RunEvent, StepStatus } from '@speqkit/plugin-api'

/**
 * The summary, as a shape rather than as a file.
 *
 * Folded from the event stream and nothing else — no reach into the runner's
 * result object — so `speq report` replaying a recorded run produces byte-for
 * -byte the same summary as the run that recorded it. That property is worth
 * more than the convenience of reading the outcome directly: a report you
 * cannot regenerate is a report you cannot check.
 */

export interface JsonTest {
  /** The test's identity — `id:` in the file, and what a failure is keyed by. */
  id: string
  title?: string
  status: StepStatus
  durationMs: number
  /** The first thing that went wrong, which is what a summary table shows. */
  message?: string
  /** Everything that went wrong, in the order the run found out. */
  messages: string[]
  suite: string
  file?: string
  /** Why it did not run. Present only on a pending test. */
  pending?: string
  meta?: Record<string, unknown>
}

export interface JsonTotals {
  total: number
  passed: number
  failed: number
  errored: number
  skipped: number
  /**
   * The same number as `skipped`, under the name a 1.x workflow reads.
   *
   * Not a synonym we like. A `jq` expression in another repository says
   * `.totals.pending // 0`, and the `// 0` means dropping the key would make
   * that workflow report zero pending tests rather than fail — the summary
   * would be wrong and nothing would say so. A shape other people parse stops
   * being ours to tidy the moment they parse it.
   */
  pending: number
}

export interface JsonRun {
  status: StepStatus
  runId?: string
  startedAt?: string
  durationMs: number
  totals: JsonTotals
  tests: JsonTest[]
}

export class SummaryBuilder {
  #tests: JsonTest[] = []
  #suite = '(inline)'
  #current: JsonTest | undefined
  #runId: string | undefined
  #startedAt: number | undefined
  #durationMs = 0
  #status: StepStatus = 'passed'

  on(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        this.reset()
        this.#runId = event.runId
        this.#startedAt = event.at
        break

      // A test does not carry its suite; the bracketing does, and the recorded
      // log preserves the order, so this holds on replay too.
      case 'suite.started':
        this.#suite = event.suite
        break

      case 'test.started':
        this.#current = {
          id: event.test,
          ...(event.title ? { title: event.title } : {}),
          status: 'passed',
          durationMs: 0,
          messages: [],
          suite: this.#suite,
          ...(event.source ? { file: event.source } : {}),
          ...(event.meta ? { meta: event.meta } : {})
        }
        break

      case 'test.skipped':
        if (this.#current) this.#current.pending = event.reason
        break

      case 'step.finished':
        if (this.#current && event.status !== 'passed' && event.status !== 'skipped') {
          const label = event.stepId ? `${event.stepId} (${event.stepType})` : event.stepType
          this.#current.messages.push(`${label}: ${event.message ?? event.status}`)
        }
        break

      case 'assertion.evaluated':
        if (this.#current && !event.passed) this.#current.messages.push(event.message)
        break

      case 'test.finished': {
        const entry = this.#current
        this.#current = undefined
        if (!entry) break
        entry.status = event.status
        entry.durationMs = event.durationMs
        if (entry.messages[0]) entry.message = entry.messages[0]
        this.#tests.push(entry)
        break
      }

      case 'run.finished':
        this.#durationMs = event.durationMs
        this.#status = event.status
        break
    }
  }

  /** One reporter instance may see several runs — a replay, a long-lived host. */
  reset(): void {
    this.#tests = []
    this.#suite = '(inline)'
    this.#current = undefined
    this.#runId = undefined
    this.#startedAt = undefined
    this.#durationMs = 0
    this.#status = 'passed'
  }

  result(): JsonRun {
    const count = (status: StepStatus) => this.#tests.filter((t) => t.status === status).length
    const skipped = count('skipped')
    return {
      status: this.#status,
      ...(this.#runId ? { runId: this.#runId } : {}),
      ...(this.#startedAt ? { startedAt: new Date(this.#startedAt).toISOString() } : {}),
      durationMs: this.#durationMs,
      totals: {
        total: this.#tests.length,
        passed: count('passed'),
        failed: count('failed'),
        errored: count('error'),
        skipped,
        pending: skipped
      },
      tests: this.#tests
    }
  }
}
