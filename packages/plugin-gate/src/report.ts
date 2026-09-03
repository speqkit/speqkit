import type { RunEvent, StepStatus } from '@speqkit/plugin-api'

/** Where the work is, when a test is not green. */
export type Fix = 'code' | 'test' | 'environment'

export interface Failure {
  kind: 'step' | 'assertion'
  /** The step it happened in, when the step had an id to name it by. */
  step?: string
  /** The step type, or the assertion type. */
  type: string
  status?: StepStatus
  message: string
  expected?: unknown
  actual?: unknown
  /** What the step recorded about itself - the exchange, for an HTTP step. */
  detail?: unknown
}

interface Row {
  name: string
  title?: string
  source?: string
  tags: string[]
  status: StepStatus
  failures: Failure[]
}

export interface GateOptions {
  /** The work this run was scoped to, when the caller knew it. */
  key?: string
  /** What a work tag looks like among a test's labels. */
  pattern: RegExp
}

const WHY: Record<Fix, string> = {
  code: 'the system answered and the answer was wrong',
  test: 'the question was never asked, and nothing else in this run hit the same wall',
  environment: 'the same step broke the same way in more than one test, so the cause is outside any of them'
}

/**
 * The run, arranged around the two questions asked about it: which piece of
 * work is red, and where does the work of fixing it go.
 *
 * Built out of the event stream and nothing else, so `speq report` replays a
 * recorded run into the same document. It keys on identity rather than on
 * adjacency - every event names the test it belongs to, and two suites running
 * at once interleave - so `--workers 4` produces what `--workers 1` produces.
 */
export class GateReport {
  #runId = ''
  #status: StepStatus = 'passed'
  #durationMs = 0
  #counts = { passed: 0, failed: 0, errored: 0, skipped: 0 }
  #tests = new Map<string, Row>()

  reset(): void {
    this.#runId = ''
    this.#status = 'passed'
    this.#durationMs = 0
    this.#counts = { passed: 0, failed: 0, errored: 0, skipped: 0 }
    this.#tests = new Map()
  }

  on(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        this.reset()
        this.#runId = event.runId
        break

      case 'test.started':
        this.#tests.set(event.test, {
          name: event.test,
          ...(event.title ? { title: event.title } : {}),
          ...(event.source ? { source: event.source } : {}),
          tags: event.tags ?? [],
          status: 'passed',
          failures: []
        })
        break

      // A step with no `test` belongs to a suite's own setup or cleanup. It is
      // not lost - it is the reason every test under that suite errored - but
      // it is reported through the tests it blocked, each of which says so
      // itself, rather than as a row belonging to nobody.
      case 'step.finished': {
        const row = event.test === undefined ? undefined : this.#tests.get(event.test)
        if (!row || (event.status !== 'failed' && event.status !== 'error')) break
        row.failures.push({
          kind: 'step',
          ...(event.stepId ? { step: event.stepId } : {}),
          type: event.stepType,
          status: event.status,
          message: event.message ?? event.status,
          ...(event.detail !== undefined ? { detail: event.detail } : {})
        })
        break
      }

      case 'assertion.evaluated': {
        const row = event.test === undefined ? undefined : this.#tests.get(event.test)
        if (!row || event.passed) break
        row.failures.push({
          kind: 'assertion',
          ...(event.stepId ? { step: event.stepId } : {}),
          type: event.assertionType,
          message: event.message,
          ...(event.expected !== undefined ? { expected: event.expected } : {}),
          ...(event.actual !== undefined ? { actual: event.actual } : {})
        })
        break
      }

      case 'test.finished': {
        const row = this.#tests.get(event.test)
        if (row) row.status = event.status
        break
      }

      case 'run.finished':
        this.#status = event.status
        this.#durationMs = event.durationMs
        this.#counts = {
          passed: event.passed,
          failed: event.failed,
          errored: event.errored,
          skipped: event.skipped
        }
        break
    }
  }

  result(options: GateOptions): Record<string, unknown> {
    const rows = [...this.#tests.values()]
    const red = rows.filter((row) => row.status === 'failed' || row.status === 'error')
    const shared = sharedCauses(red)

    const routed = red.map((row) => {
      const fix = route(row, shared)
      return {
        name: row.name,
        ...(row.title ? { title: row.title } : {}),
        ...(row.source ? { source: row.source } : {}),
        ...(row.tags.length > 0 ? { tags: row.tags } : {}),
        status: row.status,
        fix,
        why: WHY[fix],
        failures: row.failures
      }
    })

    const work = new Map<string, Counts & { key: string }>()
    const unclaimed: string[] = []
    for (const row of rows) {
      const keys = row.tags.filter((tag) => options.pattern.test(tag))
      if (keys.length === 0) unclaimed.push(row.name)
      for (const key of keys) {
        const entry = work.get(key) ?? { key, passed: 0, failed: 0, errored: 0, skipped: 0 }
        count(entry, row.status)
        work.set(key, entry)
      }
    }

    return {
      runId: this.#runId,
      status: this.#status,
      durationMs: this.#durationMs,
      ...(options.key ? { key: options.key } : {}),
      counts: this.#counts,
      // Ordered by name, so two runs of one project produce the same document
      // and a diff between two of them means something.
      work: [...work.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((entry) => ({ ...entry, status: verdict(entry) })),
      unclaimed: unclaimed.sort(),
      blame: {
        code: routed.filter((row) => row.fix === 'code').length,
        test: routed.filter((row) => row.fix === 'test').length,
        environment: routed.filter((row) => row.fix === 'environment').length
      },
      tests: routed
    }
  }
}

interface Counts { passed: number; failed: number; errored: number; skipped: number }

function count(entry: Counts, status: StepStatus): void {
  if (status === 'passed') entry.passed += 1
  else if (status === 'failed') entry.failed += 1
  else if (status === 'error') entry.errored += 1
  else entry.skipped += 1
}

function verdict(entry: Counts): StepStatus {
  if (entry.failed > 0) return 'failed'
  if (entry.errored > 0) return 'error'
  return entry.passed > 0 ? 'passed' : 'skipped'
}

/**
 * Two tests that broke identically did not both break for their own reasons.
 *
 * This is the whole of the environment heuristic, and it deliberately does not
 * read the message: it never asks what `ECONNREFUSED` means, only whether the
 * same step type broke with the same words somewhere else in the run. A cause
 * two tests share is by definition not inside either of them.
 *
 * What it gets wrong is written down rather than hidden. A run of one test
 * cannot have a shared anything, so a lone test brought down by a service that
 * was never up is reported as `test` - the run holds no evidence to say
 * otherwise. And two tests carrying the same bug are reported as
 * `environment`. Both are the price of not parsing messages, which is the
 * approach that would rot the first time somebody reworded one.
 */
function sharedCauses(rows: Row[]): Set<string> {
  const seen = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const failure of row.failures) {
      if (failure.kind !== 'step' || failure.status !== 'error') continue
      const cause = causeOf(failure)
      const tests = seen.get(cause) ?? new Set<string>()
      tests.add(row.name)
      seen.set(cause, tests)
    }
  }
  return new Set([...seen].filter(([, tests]) => tests.size > 1).map(([cause]) => cause))
}

const causeOf = (failure: Failure): string => `${failure.type}: ${failure.message}`

/**
 * `failed` and `error` have meant "the answer was wrong" and "the question was
 * never asked" since the kernel's first commit, and nothing had ever told a
 * caller that this is the line between fixing the code and fixing the test.
 * The first half of this function is that distinction, and it is not a guess.
 */
function route(row: Row, shared: Set<string>): Fix {
  const answered = row.failures.some(
    (failure) => failure.kind === 'assertion' || failure.status === 'failed'
  )
  if (answered) return 'code'

  const blocked = row.failures.some(
    (failure) => failure.status === 'error' && shared.has(causeOf(failure))
  )
  return blocked ? 'environment' : 'test'
}
