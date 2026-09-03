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
  /**
   * The tests still running, by name.
   *
   * This used to be a single `#current` slot with a `#suite` string beside it,
   * both of them read from whatever arrived last. That is adjacency, and G4
   * says events of different suites interleave — so at `--workers 2` a step's
   * message landed on whichever test happened to start most recently, and
   * every test was filed under whichever suite opened most recently. The
   * summary was wrong and nothing about it looked wrong.
   *
   * The same fault was fixed in `plugin-junit` a milestone earlier. It
   * survived here because a reporter is only ever wrong on the inside: the
   * run's exit code is the runner's, and it stayed right.
   */
  #open = new Map<string, JsonTest>()
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

      // The test says which suite it is in. The last `suite.started` used to
      // say it, which is true only while one suite runs at a time. A stream
      // recorded before the event carried it still replays: the fallback is
      // the file, which is the leaf suite's name.
      case 'test.started':
        this.#open.set(event.test, {
          id: event.test,
          ...(event.title ? { title: event.title } : {}),
          status: 'passed',
          durationMs: 0,
          messages: [],
          suite: event.suite ?? event.source ?? '(inline)',
          ...(event.source ? { file: event.source } : {}),
          ...(event.meta ? { meta: event.meta } : {})
        })
        break

      case 'test.skipped': {
        const entry = this.#open.get(event.test)
        if (entry) entry.pending = event.reason
        break
      }

      // A step naming no test belongs to a suite's own setup or cleanup. It is
      // the reason every test under that suite errored, and each of those says
      // so itself, so nothing is lost by not filing it against a test.
      case 'step.finished': {
        const entry = open(this.#open, event.test)
        if (entry && event.status !== 'passed' && event.status !== 'skipped') {
          const label = event.stepId ? `${event.stepId} (${event.stepType})` : event.stepType
          entry.messages.push(`${label}: ${event.message ?? event.status}`)
        }
        break
      }

      case 'assertion.evaluated': {
        const entry = open(this.#open, event.test)
        if (entry && !event.passed) entry.messages.push(event.message)
        break
      }

      case 'test.finished': {
        const entry = this.#open.get(event.test)
        if (!entry) break
        this.#open.delete(event.test)
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
    this.#open = new Map()
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

/** A step or assertion belongs to a test only when it names one. */
function open(tests: Map<string, JsonTest>, test: string | undefined): JsonTest | undefined {
  return test === undefined ? undefined : tests.get(test)
}
