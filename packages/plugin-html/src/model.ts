import type { RunEvent, StepStatus, TestPhase } from '@speqkit/plugin-api'

export interface HtmlAssertion {
  type: string
  passed: boolean
  message: string
  /** Carried only when it failed — the same terms the event carries them on. */
  expected?: unknown
  actual?: unknown
}

export interface HtmlStep {
  id?: string
  type: string
  status: StepStatus
  durationMs: number
  message?: string
  /** What the step type recorded about itself: the exchange, not a sentence about it. */
  detail?: unknown
  phase?: TestPhase
  meta?: Record<string, unknown>
  steps: HtmlStep[]
  /** Assertions that named this step. */
  assertions: HtmlAssertion[]
}

export interface HtmlArtifact {
  name: string
  contentType: string
  bytes: number
  /** Where the run wrote it, as recorded on the event. */
  path?: string
  /**
   * How the page reaches it: a `data:` URI for anything small enough to carry,
   * a path relative to the HTML file for the rest. Absent when the run kept
   * the bytes in memory and wrote nothing.
   */
  href?: string
}

export interface HtmlTest {
  name: string
  title?: string
  suite: string
  source?: string
  /** The `cases` row this came from, when it came from one. */
  group?: string
  tags: string[]
  meta?: Record<string, unknown>
  status: StepStatus
  durationMs: number
  steps: HtmlStep[]
  /** Assertions that named no step — a bare `assert:` block. */
  assertions: HtmlAssertion[]
  artifacts: HtmlArtifact[]
  /** Why it is not green, in the order the run found out. */
  failures: string[]
  /** Set when the test never ran, carrying the reason it gave. */
  skipped?: string
}

export interface HtmlSuite {
  name: string
  title?: string
  parent?: string
  /** Test names, in the order they finished. */
  tests: string[]
}

/** A capability, and the plugin that contributed it. */
export interface HtmlOwner {
  plugin: string
  /** One sentence, from the plugin that defined it. */
  summary?: string
}

export interface HtmlOwners {
  steps: Record<string, HtmlOwner>
  assertions: Record<string, HtmlOwner>
}

export interface HtmlTotals {
  tests: number
  passed: number
  failed: number
  error: number
  skipped: number
}

export interface HtmlReport {
  runId?: string
  /** `run.started.at` — the one absolute instant the stream carries. */
  startedAt: number
  durationMs: number
  status: StepStatus
  totals: HtmlTotals
  suites: HtmlSuite[]
  tests: HtmlTest[]
  /**
   * Which plugin owns each word a test is written in, and what it says it is.
   *
   * Not folded out of the stream — the stream says a step's type and never
   * whose type it is. It comes from `host.capabilities()`, and it is the one
   * thing in this report a reader cannot work out from the test file in front
   * of them: `browser.open` is a step and `@speqkit/plugin-playwright` is the
   * reason it exists.
   */
  owners: HtmlOwners
  /** Diagnostics the run emitted, which are not attached to any test. */
  notes: { level: string; message: string; source?: string }[]
  /** The `--env` layer in effect, when one was. */
  env?: string
}

interface OpenTest {
  test: HtmlTest
  /** Steps still running, innermost last — steps inside a test never overlap. */
  stack: HtmlStep[]
  /** Finished top-level steps, by id, so an assertion can find the one it names. */
  byId: Map<string, HtmlStep>
}

/**
 * Folds the event stream into the document the page renders.
 *
 * The same shape as `plugin-junit`'s and `plugin-json`'s folds, and kept apart
 * from the rendering for the same reason: the claim that the event stream is
 * sufficient to rebuild a report is only checkable if the rebuild is a
 * function of the stream alone. Nothing here reads the runner's result object,
 * so `speq report --reporter html` produces the page a live run produced.
 */
export class ReportBuilder {
  #tests: HtmlTest[] = []
  #suites: HtmlSuite[] = []
  #bySuite = new Map<string, HtmlSuite>()
  #open = new Map<string, OpenTest>()
  #notes: HtmlReport['notes'] = []
  #runId: string | undefined
  #startedAt = 0
  #durationMs = 0
  #status: StepStatus = 'passed'
  #totals: HtmlTotals = { tests: 0, passed: 0, failed: 0, error: 0, skipped: 0 }

  on(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        this.reset()
        this.#runId = event.runId
        this.#startedAt = event.at
        break

      case 'suite.started':
        this.suiteFor(event.suite, event.title, event.parent)
        break

      case 'test.started':
        this.#open.set(event.test, {
          test: {
            name: event.test,
            ...(event.title ? { title: event.title } : {}),
            // The test says which suite it is in. Reading the last
            // `suite.started` instead is adjacency, and G4 took that away.
            suite: event.suite ?? event.source ?? '(inline)',
            ...(event.source ? { source: event.source } : {}),
            ...(event.group ? { group: event.group } : {}),
            tags: event.tags ?? [],
            ...(event.meta ? { meta: event.meta } : {}),
            status: 'passed',
            durationMs: 0,
            steps: [],
            assertions: [],
            artifacts: [],
            failures: []
          },
          stack: [],
          byId: new Map()
        })
        break

      case 'test.skipped': {
        const entry = this.#open.get(event.test)
        if (entry) entry.test.skipped = event.reason
        break
      }

      case 'step.started': {
        const step: HtmlStep = {
          ...(event.stepId ? { id: event.stepId } : {}),
          type: event.stepType,
          status: 'passed',
          durationMs: 0,
          ...(event.phase ? { phase: event.phase } : {}),
          ...(event.meta ? { meta: event.meta } : {}),
          steps: [],
          assertions: []
        }
        this.#open.get(event.test ?? '')?.stack.push(step)
        break
      }

      case 'step.finished': {
        const entry = this.#open.get(event.test ?? '')
        // A step with no test is a suite's own setup or cleanup. It has no
        // test to hang under and is not silently counted against one.
        if (!entry) break
        const step = entry.stack.pop()
        if (!step) break
        step.status = event.status
        step.durationMs = event.durationMs
        if (event.message !== undefined) step.message = event.message
        if (event.detail !== undefined) step.detail = event.detail

        const parent = entry.stack.at(-1)
        if (parent) parent.steps.push(step)
        else entry.test.steps.push(step)
        if (step.id && !parent) entry.byId.set(step.id, step)

        if (event.status !== 'passed' && event.status !== 'skipped') {
          const label = event.stepId ? `${event.stepId} (${event.stepType})` : event.stepType
          entry.test.failures.push(`step ${label}: ${event.message ?? event.status}`)
        }
        break
      }

      case 'assertion.evaluated': {
        const entry = this.#open.get(event.test ?? '')
        if (!entry) break
        const assertion: HtmlAssertion = {
          type: event.assertionType,
          passed: event.passed,
          message: event.message,
          ...(event.expected === undefined ? {} : { expected: event.expected }),
          ...(event.actual === undefined ? {} : { actual: event.actual })
        }
        const owner = event.stepId ? entry.byId.get(event.stepId) : undefined
        ;(owner ? owner.assertions : entry.test.assertions).push(assertion)
        if (!event.passed) {
          entry.test.failures.push(`assertion ${event.assertionType}: ${event.message}`)
        }
        break
      }

      case 'artifact.attached': {
        const entry = this.#open.get(event.test ?? '')
        if (!entry) break
        entry.test.artifacts.push({
          name: event.name,
          contentType: event.contentType,
          bytes: event.bytes,
          ...(event.path ? { path: event.path } : {})
        })
        break
      }

      case 'test.finished': {
        const entry = this.#open.get(event.test)
        if (!entry) break
        this.#open.delete(event.test)
        entry.test.status = event.status
        entry.test.durationMs = event.durationMs
        this.#tests.push(entry.test)
        this.suiteFor(entry.test.suite).tests.push(entry.test.name)
        break
      }

      case 'diagnostic':
        this.#notes.push({
          level: event.level,
          message: event.message,
          ...(event.source ? { source: event.source } : {})
        })
        break

      case 'run.finished':
        this.#durationMs = event.durationMs
        this.#status = event.status
        // Taken from the run rather than counted here: the run is the
        // authority on its own totals, and a report that disagreed with the
        // exit code would be the report that is wrong.
        this.#totals = {
          tests: event.passed + event.failed + event.errored + event.skipped,
          passed: event.passed,
          failed: event.failed,
          error: event.errored,
          skipped: event.skipped
        }
        break
    }
  }

  /**
   * A reporter is registered once and may see several runs in one process.
   * Two runs' worth of tests on one page would be nobody's intent.
   */
  reset(): void {
    this.#tests = []
    this.#suites = []
    this.#bySuite = new Map()
    this.#open = new Map()
    this.#notes = []
    this.#runId = undefined
    this.#startedAt = 0
    this.#durationMs = 0
    this.#status = 'passed'
    this.#totals = { tests: 0, passed: 0, failed: 0, error: 0, skipped: 0 }
  }

  result(context: { owners?: HtmlOwners; env?: string } = {}): HtmlReport {
    return {
      ...(this.#runId ? { runId: this.#runId } : {}),
      startedAt: this.#startedAt,
      durationMs: this.#durationMs,
      status: this.#status,
      totals: this.#totals,
      suites: this.#suites.filter((suite) => suite.tests.length > 0),
      tests: this.#tests,
      owners: context.owners ?? { steps: {}, assertions: {} },
      notes: this.#notes,
      ...(context.env ? { env: context.env } : {})
    }
  }

  private suiteFor(name: string, title?: string, parent?: string): HtmlSuite {
    let suite = this.#bySuite.get(name)
    if (!suite) {
      suite = { name, ...(title ? { title } : {}), ...(parent ? { parent } : {}), tests: [] }
      this.#bySuite.set(name, suite)
      this.#suites.push(suite)
    }
    return suite
  }
}
