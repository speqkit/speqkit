import type { RunEvent, StepStatus } from '@speqkit/plugin-api'

export interface JUnitCase {
  name: string
  suite: string
  file?: string
  status: StepStatus
  durationMs: number
  /** Why it failed, in the order the run found out. */
  failures: string[]
  /** Free-form lines CI viewers show under the case. */
  output: string[]
}

export interface JUnitSuite {
  name: string
  cases: JUnitCase[]
}

export interface JUnitRun {
  runId?: string
  durationMs: number
  suites: JUnitSuite[]
}

/**
 * Folds the event stream into the shape JUnit wants.
 *
 * Kept apart from the file writing so it can be tested on a plain list of
 * events, and so `speq report` and a live run go through exactly the same
 * code — the event stream being sufficient on its own is the property worth
 * protecting.
 */
export class RunBuilder {
  #suites: JUnitSuite[] = []
  #byName = new Map<string, JUnitSuite>()
  #suite = '(inline)'
  #case: JUnitCase | undefined
  #runId: string | undefined
  #durationMs = 0

  on(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        this.reset()
        this.#runId = event.runId
        break

      // Tests do not carry their suite on the event; the bracketing does. That
      // holds on replay too, because the log preserves the order.
      case 'suite.started':
        this.#suite = event.suite
        break

      case 'test.started':
        this.#case = {
          name: event.test,
          suite: this.#suite,
          file: event.source,
          status: 'passed',
          durationMs: 0,
          failures: [],
          output: []
        }
        break

      case 'step.finished':
        if (this.#case && event.status !== 'passed' && event.status !== 'skipped') {
          const label = event.stepId ? `${event.stepId} (${event.stepType})` : event.stepType
          this.#case.failures.push(`step ${label}: ${event.message ?? event.status}`)
        }
        break

      case 'assertion.evaluated':
        if (this.#case && !event.passed) {
          this.#case.failures.push(`assertion ${event.assertionType}: ${event.message}`)
        }
        break

      case 'artifact.attached':
        this.#case?.output.push(`[[ATTACHMENT|${event.path ?? event.name}]]`)
        break

      case 'test.finished': {
        const entry = this.#case
        this.#case = undefined
        if (!entry) break
        entry.status = event.status
        entry.durationMs = event.durationMs
        this.suiteFor(entry.suite).cases.push(entry)
        break
      }

      case 'run.finished':
        this.#durationMs = event.durationMs
        break
    }
  }

  /**
   * A reporter is registered once and may see several runs in one process —
   * `speq report` replaying after a run, or a long-lived editor session. Two
   * runs' worth of cases in one file would be nobody's intent.
   */
  reset(): void {
    this.#suites = []
    this.#byName = new Map()
    this.#suite = '(inline)'
    this.#case = undefined
    this.#runId = undefined
    this.#durationMs = 0
  }

  result(): JUnitRun {
    return { runId: this.#runId, durationMs: this.#durationMs, suites: this.#suites }
  }

  private suiteFor(name: string): JUnitSuite {
    let suite = this.#byName.get(name)
    if (!suite) {
      suite = { name, cases: [] }
      this.#byName.set(name, suite)
      this.#suites.push(suite)
    }
    return suite
  }
}

export interface RenderOptions {
  name: string
}

export function renderJUnit(run: JUnitRun, options: RenderOptions): string {
  const all = run.suites.flatMap((s) => s.cases)
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="${esc(options.name)}" tests="${all.length}" ` +
      `failures="${count(all, 'failed')}" errors="${count(all, 'error')}" ` +
      `skipped="${count(all, 'skipped')}" time="${seconds(run.durationMs)}">`
  ]

  for (const suite of run.suites) {
    lines.push(
      `  <testsuite name="${esc(suite.name)}" tests="${suite.cases.length}" ` +
        `failures="${count(suite.cases, 'failed')}" errors="${count(suite.cases, 'error')}" ` +
        `skipped="${count(suite.cases, 'skipped')}" ` +
        `time="${seconds(suite.cases.reduce((sum, c) => sum + c.durationMs, 0))}">`
    )
    for (const entry of suite.cases) lines.push(...renderCase(entry))
    lines.push(`  </testsuite>`)
  }

  lines.push(`</testsuites>`)
  return `${lines.join('\n')}\n`
}

function renderCase(entry: JUnitCase): string[] {
  const attrs =
    `name="${esc(entry.name)}" classname="${esc(entry.suite)}" ` +
    `time="${seconds(entry.durationMs)}"` +
    (entry.file ? ` file="${esc(entry.file)}"` : '')

  const body: string[] = []
  if (entry.status === 'skipped') {
    body.push(`      <skipped/>`)
  } else if (entry.status === 'failed' || entry.status === 'error') {
    // JUnit distinguishes the two, and so does the spine: `failed` is the
    // system under test saying no, `error` is the test never getting an answer
    // at all. Reporting both as failures is what makes a flaky environment
    // look like a broken build.
    const tag = entry.status === 'error' ? 'error' : 'failure'
    const message = entry.failures[0] ?? entry.status
    body.push(
      `      <${tag} message="${esc(message)}" type="${entry.status}">` +
        `${esc(entry.failures.join('\n'))}</${tag}>`
    )
  }
  if (entry.output.length > 0) {
    body.push(`      <system-out>${esc(entry.output.join('\n'))}</system-out>`)
  }

  return body.length === 0
    ? [`    <testcase ${attrs}/>`]
    : [`    <testcase ${attrs}>`, ...body, `    </testcase>`]
}

function count(cases: JUnitCase[], status: StepStatus): number {
  return cases.filter((c) => c.status === status).length
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3)
}

/**
 * Escapes for both attribute and text position, so one function covers every
 * place a value can land.
 *
 * The control-character strip is not pedantry. XML 1.0 cannot represent them at
 * all, and assertion messages routinely carry terminal colour codes — the
 * console reporter's own output is full of them. One escape sequence is enough
 * to make the file unparseable by the CI that has to read it, and a CI that
 * cannot parse the report shows the build as broken rather than the report.
 */
function esc(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '&#10;')
}
