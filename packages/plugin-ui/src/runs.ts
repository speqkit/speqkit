import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordedRun, RunEvent, StepStatus, TestPhase } from '@speqkit/plugin-api'

const FILE = 'events.jsonl'

export interface RunAssertion {
  type: string
  passed: boolean
  message: string
  expected?: unknown
  actual?: unknown
}

export interface RunStep {
  id?: string
  type: string
  status: StepStatus
  durationMs: number
  message?: string
  detail?: unknown
  phase?: TestPhase
  steps: RunStep[]
  assertions: RunAssertion[]
}

export interface RunArtifact {
  name: string
  contentType: string
  bytes: number
  /**
   * A path under `/artifacts/`, which the server resolves back inside the
   * report directory. The absolute path the event carries never reaches the
   * browser: a page that can name a file on the machine is a page that can
   * ask for `/etc/passwd`.
   */
  href?: string
}

export interface RunTest {
  name: string
  title?: string
  suite: string
  source?: string
  group?: string
  tags: string[]
  meta?: Record<string, unknown>
  status: StepStatus
  durationMs: number
  steps: RunStep[]
  assertions: RunAssertion[]
  artifacts: RunArtifact[]
  failures: string[]
  skipped?: string
}

export interface RunTotals {
  tests: number
  passed: number
  failed: number
  error: number
  skipped: number
}

/** What a row in the history list needs, and nothing more. */
export interface RunSummary {
  runId: string
  at: number
  status: StepStatus
  durationMs: number
  totals: RunTotals
}

export interface RunDocument extends RunSummary {
  suites: { name: string; title?: string; tests: string[] }[]
  tests: RunTest[]
  notes: { level: string; message: string; source?: string }[]
}

/**
 * Reads a recorded run back off disk.
 *
 * Malformed lines are skipped rather than fatal: a run that crashed can leave
 * a half-written last line, and that is exactly the run somebody has opened
 * this page to look at.
 */
export function readEvents(dir: string): RunEvent[] {
  const file = join(dir, FILE)
  if (!existsSync(file)) return []
  const events: RunEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as RunEvent)
    } catch {
      continue
    }
  }
  return events
}

/**
 * The history list, without folding every run in full.
 *
 * A project with three hundred recorded runs would otherwise parse three
 * hundred whole event logs to draw a list of dates, and the list is the first
 * thing the page asks for. Only the first and last lines of each log carry
 * what a row needs.
 */
export function summarise(run: RecordedRun): RunSummary {
  const file = join(run.dir, FILE)
  let first: RunEvent | undefined
  let last: RunEvent | undefined
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
    first = parse(lines[0])
    // The last line of a crashed run is whatever it got to, so the finish is
    // looked for from the end rather than assumed to be there.
    for (let i = lines.length - 1; i >= 0 && !last; i--) {
      const event = parse(lines[i])
      if (event?.type === 'run.finished') last = event
    }
  } catch {
    /* an unreadable run is a row that says so, below */
  }

  const at = first?.type === 'run.started' ? first.at : run.at
  if (last?.type !== 'run.finished') {
    // No `run.finished` means the process died mid-run. Saying `error` is the
    // honest answer; leaving the row out would hide the only evidence there is.
    return {
      runId: run.runId,
      at,
      status: 'error',
      durationMs: 0,
      totals: { tests: 0, passed: 0, failed: 0, error: 0, skipped: 0 }
    }
  }

  return {
    runId: run.runId,
    at,
    status: last.status,
    durationMs: last.durationMs,
    totals: {
      tests: last.passed + last.failed + last.errored + last.skipped,
      passed: last.passed,
      failed: last.failed,
      error: last.errored,
      skipped: last.skipped
    }
  }
}

function parse(line: string | undefined): RunEvent | undefined {
  if (!line) return undefined
  try {
    return JSON.parse(line) as RunEvent
  } catch {
    return undefined
  }
}

/** One test's outcome in one run, for the strip beside its name. */
export interface HistoryPoint {
  runId: string
  at: number
  status: StepStatus
  durationMs: number
}

export interface History {
  runs: RunSummary[]
  /** Keyed by test name — the identity, which is what a rerun addresses. */
  tests: Record<string, HistoryPoint[]>
}

/**
 * How each test has been doing, across the runs on disk.
 *
 * This is the question a suite tree cannot answer and a single report cannot
 * either: not "did this fail" but "does this fail". A test red once is a bug;
 * a test red every third run is a different problem with a different owner,
 * and until you can see the strip there is no way to tell them apart.
 *
 * Only `run.started` and `test.finished` are read, so a project with three
 * hundred runs does not fold three hundred whole logs to draw it.
 */
export function historyOf(runs: { runId: string; dir: string; at: number }[]): History {
  const summaries: RunSummary[] = []
  const tests: Record<string, HistoryPoint[]> = {}

  for (const run of runs) {
    const summary = summarise(run)
    summaries.push(summary)
    for (const event of readEvents(run.dir)) {
      if (event.type !== 'test.finished') continue
      ;(tests[event.test] ??= []).push({
        runId: run.runId,
        at: summary.at,
        status: event.status,
        durationMs: event.durationMs
      })
    }
  }

  return { runs: summaries, tests }
}

interface Open {
  test: RunTest
  /** Steps still running, innermost last — steps inside a test never overlap. */
  stack: RunStep[]
  byId: Map<string, RunStep>
}

/**
 * The fold: a recorded run, as the page shows it.
 *
 * This is deliberately its own copy of a fold `plugin-junit`, `plugin-json`
 * and `plugin-html` each also write. A plugin in this repository depends on
 * `@speqkit/plugin-api` and on nothing else of ours, so sharing it would mean
 * one plugin installing another into the store to reach a pure function — and
 * the contract this all rests on is precisely that the event stream is enough
 * to write a reporter *without* our help. Four independent folds that agree
 * are evidence for that claim; one shared helper would be evidence for
 * nothing.
 *
 * `artifacts` is the one place this differs from the others: the event carries
 * an absolute path on the machine that ran the tests, and what goes to the
 * browser is a URL under `/artifacts/` that the server resolves back inside
 * the report directory.
 */
export function foldRun(events: RunEvent[], runId: string): RunDocument {
  const summary: RunSummary = {
    runId,
    at: 0,
    status: 'error',
    durationMs: 0,
    totals: { tests: 0, passed: 0, failed: 0, error: 0, skipped: 0 }
  }
  const tests: RunTest[] = []
  const suites: RunDocument['suites'] = []
  const bySuite = new Map<string, RunDocument['suites'][number]>()
  const notes: RunDocument['notes'] = []
  const open = new Map<string, Open>()

  const suiteFor = (name: string, title?: string): RunDocument['suites'][number] => {
    let suite = bySuite.get(name)
    if (!suite) {
      suite = { name, ...(title ? { title } : {}), tests: [] }
      bySuite.set(name, suite)
      suites.push(suite)
    }
    return suite
  }

  for (const event of events) {
    switch (event.type) {
      case 'run.started':
        summary.at = event.at
        break

      case 'suite.started':
        suiteFor(event.suite, event.title)
        break

      case 'test.started':
        open.set(event.test, {
          test: {
            name: event.test,
            ...(event.title ? { title: event.title } : {}),
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
        const entry = open.get(event.test)
        if (entry) entry.test.skipped = event.reason
        break
      }

      case 'step.started':
        open.get(event.test ?? '')?.stack.push({
          ...(event.stepId ? { id: event.stepId } : {}),
          type: event.stepType,
          status: 'passed',
          durationMs: 0,
          ...(event.phase ? { phase: event.phase } : {}),
          steps: [],
          assertions: []
        })
        break

      case 'step.finished': {
        const entry = open.get(event.test ?? '')
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
        const entry = open.get(event.test ?? '')
        if (!entry) break
        const assertion: RunAssertion = {
          type: event.assertionType,
          passed: event.passed,
          message: event.message,
          ...(event.expected === undefined ? {} : { expected: event.expected }),
          ...(event.actual === undefined ? {} : { actual: event.actual })
        }
        const owner = event.stepId ? entry.byId.get(event.stepId) : undefined
        ;(owner ? owner.assertions : entry.test.assertions).push(assertion)
        if (!event.passed) entry.test.failures.push(`assertion ${event.assertionType}: ${event.message}`)
        break
      }

      case 'artifact.attached': {
        const entry = open.get(event.test ?? '')
        if (!entry) break
        entry.test.artifacts.push({
          name: event.name,
          contentType: event.contentType,
          bytes: event.bytes,
          ...(event.path ? { href: artifactHref(runId, event.path) } : {})
        })
        break
      }

      case 'test.finished': {
        const entry = open.get(event.test)
        if (!entry) break
        open.delete(event.test)
        entry.test.status = event.status
        entry.test.durationMs = event.durationMs
        tests.push(entry.test)
        suiteFor(entry.test.suite).tests.push(entry.test.name)
        break
      }

      case 'diagnostic':
        notes.push({
          level: event.level,
          message: event.message,
          ...(event.source ? { source: event.source } : {})
        })
        break

      case 'run.finished':
        summary.status = event.status
        summary.durationMs = event.durationMs
        summary.totals = {
          tests: event.passed + event.failed + event.errored + event.skipped,
          passed: event.passed,
          failed: event.failed,
          error: event.errored,
          skipped: event.skipped
        }
        break
    }
  }

  return { ...summary, suites: suites.filter((s) => s.tests.length > 0), tests, notes }
}

/**
 * The tail of an artifact's absolute path, from the run id onwards.
 *
 * The store writes `<reportDir>/<runId>/artifacts/<test>/<file>`, so the run
 * id is the anchor: everything from it is the part the server can resolve
 * again, and everything before it is a directory layout on somebody's laptop
 * that the browser has no business knowing.
 */
export function artifactHref(runId: string, path: string): string {
  const normalised = path.split(/[\\/]/)
  const at = normalised.lastIndexOf(runId)
  const tail = at >= 0 ? normalised.slice(at + 1) : normalised.slice(-1)
  return `/artifacts/${[runId, ...tail].map(encodeURIComponent).join('/')}`
}
