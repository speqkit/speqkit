import type { RunEvent, StepStatus } from '@speqkit/plugin-api'

/* ------------------------------------------------------------------ */
/* The Allure 2 result model, as much of it as a run can honestly fill */
/* ------------------------------------------------------------------ */

/** `passed` and `skipped` are the same word in both models; the other two are not. */
export type AllureStatus = 'passed' | 'failed' | 'broken' | 'skipped'

export interface AllureStatusDetails {
  message?: string
  trace?: string
}

export interface AllureParameter {
  name: string
  value: string
}

export interface AllureAttachment {
  name: string
  /** The file's name inside the results directory — never a path outside it. */
  source: string
  type: string
}

export interface AllureStep {
  name: string
  status: AllureStatus
  statusDetails?: AllureStatusDetails
  stage: 'finished'
  start: number
  stop: number
  steps: AllureStep[]
  parameters: AllureParameter[]
  attachments: AllureAttachment[]
}

export interface AllureLabel {
  name: string
  value: string
}

export interface AllureLink {
  name: string
  url: string
  type?: string
}

export interface AllureResult {
  uuid: string
  /**
   * What makes two runs of the same test the same row in the trend.
   *
   * Derived from the name and nothing else — not from the run id, not from the
   * order the test ran in, not from a duration. A history id that moves is a
   * test Allure shows as new every time, which is the whole trend gone.
   */
  historyId: string
  testCaseId: string
  name: string
  fullName: string
  status: AllureStatus
  statusDetails?: AllureStatusDetails
  stage: 'finished'
  start: number
  stop: number
  description?: string
  labels: AllureLabel[]
  links: AllureLink[]
  parameters: AllureParameter[]
  steps: AllureStep[]
  attachments: AllureAttachment[]
}

export interface AllureContainer {
  uuid: string
  name: string
  children: string[]
  befores: AllureStep[]
  afters: AllureStep[]
  start: number
  stop: number
}

/** One attachment the writer still has to copy out of the run directory. */
export interface PendingCopy {
  /** Where the run wrote it: an absolute path under `reports/<runId>/artifacts/`. */
  from: string
  /** What it is called in the results directory: `<uuid>-attachment.<ext>`. */
  to: string
}

export interface AllureBundle {
  results: AllureResult[]
  containers: AllureContainer[]
  copies: PendingCopy[]
  /** `run.started.at`, so the writer can stamp `environment.properties`. */
  startedAt: number
  runId?: string
}

/* ------------------------------------------------------------------ */
/* The fold                                                            */
/* ------------------------------------------------------------------ */

export interface BuilderOptions {
  /**
   * Where the clock comes from.
   *
   * Injected so a test can fold a stream into a file whose timestamps are
   * fixed, which is the only way to assert on one.
   */
  now?: () => number
  /**
   * Turned into the `uuid` on every result, container and attachment.
   *
   * Allure only needs these to be distinct within one results directory, so
   * the default is a counter rather than `randomUUID`: a fold run twice over
   * the same stream then produces the same files, and a test can say so.
   */
  uuid?: () => string
  /** `meta` keys promoted to Allure's own labels — see `LABEL_KEYS`. */
  labels?: Record<string, string>
}

/**
 * `meta` keys that mean something to Allure, mapped to the label it knows.
 *
 * Everything else in `meta` becomes a parameter instead of being dropped: a
 * team annotates tests with whatever it annotates them with, and a reporter
 * that only understands its own six words throws the rest away silently.
 */
const LABEL_KEYS: Record<string, string> = {
  owner: 'owner',
  severity: 'severity',
  feature: 'feature',
  story: 'story',
  epic: 'epic',
  package: 'package',
  layer: 'layer'
}

/** speq's four statuses, in Allure's words. */
export function statusOf(status: StepStatus): AllureStatus {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'skipped':
      return 'skipped'
    case 'failed':
      // The system under test answered, and the answer was wrong.
      return 'failed'
    default:
      // It never answered at all. Allure calls that `broken`, and keeping the
      // distinction is what stops a flaky environment from reading as a
      // broken build — the same reason `plugin-junit` writes `<error>` here.
      return 'broken'
  }
}

interface OpenTest {
  result: AllureResult
  container: AllureContainer
  /**
   * Steps still running, innermost last.
   *
   * A stack rather than a lookup by `parentId`, because steps inside one test
   * never overlap — that is a guarantee the contract makes, and the reason
   * `depth` and `parentId` on the event agree with the order they arrive in.
   * The map keyed by test name above is what handles the part that *can*
   * overlap, which is two suites.
   */
  stack: AllureStep[]
  failures: AllureStatusDetails[]
}

/**
 * Folds the event stream into the files `allure generate` reads.
 *
 * Kept apart from the writing, exactly as `plugin-junit` keeps its own fold
 * apart, so the claim underneath every reporter here stays checkable: the
 * stream is sufficient. Nothing below reaches for the runner's result object,
 * and a recorded `events.jsonl` replayed through it produces the same bundle
 * the live run did.
 *
 * ## About time
 *
 * Allure's timeline wants absolute start and stop instants, and the stream
 * carries exactly one absolute instant — `run.started.at`. Everything else is
 * a duration. So a start is the run's instant plus the reporter's own elapsed
 * time when the `started` event arrived, and a stop is that start plus the
 * duration the run reported. Never the other way round: durations come from
 * the run and are exact everywhere, and the clock only decides where things
 * sit relative to each other.
 *
 * On a live run that is the truth. On `speq report --reporter allure` the
 * whole log arrives at once, so every test starts at the instant the original
 * run did and the stagger between them is lost — a bounded and stateable
 * loss. The alternative, stamping the replay's own wall clock, would be a
 * report claiming a run happened this afternoon when it happened in CI last
 * week.
 */
export class RunBuilder {
  #results: AllureResult[] = []
  #containers: AllureContainer[] = []
  #copies: PendingCopy[] = []
  #open = new Map<string, OpenTest>()
  /** Suite containers, so a suite's own setup and cleanup land somewhere. */
  #suites = new Map<string, AllureContainer>()
  #runId: string | undefined
  #startedAt = 0
  #t0 = 0
  #counter = 0

  readonly #now: () => number
  readonly #uuid: () => string
  readonly #labels: Record<string, string>

  constructor(options: BuilderOptions = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#uuid = options.uuid ?? (() => `speq-${String(++this.#counter).padStart(6, '0')}`)
    this.#labels = { ...LABEL_KEYS, ...(options.labels ?? {}) }
  }

  on(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        this.reset()
        this.#runId = event.runId
        this.#startedAt = event.at
        this.#t0 = this.#now()
        break

      case 'suite.started':
        this.suiteFor(event.suite, event.title)
        break

      case 'test.started': {
        const at = this.clock()
        const suite = event.suite ?? event.source ?? '(inline)'
        const name = event.title ?? event.test
        const fullName = `${suite}#${event.test}`
        const result: AllureResult = {
          uuid: this.#uuid(),
          historyId: hash(fullName),
          testCaseId: hash(fullName),
          name,
          fullName,
          status: 'passed',
          stage: 'finished',
          start: at,
          stop: at,
          labels: this.labelsFor(event, suite),
          links: linksFor(event.meta),
          parameters: parametersFor(event.meta, this.#labels),
          steps: [],
          attachments: []
        }
        // A container per test, not per suite: `befores` and `afters` are how
        // Allure shows setup and cleanup, and speq's setup runs per test.
        // A suite's own setup gets the suite's container instead, below.
        const container: AllureContainer = {
          uuid: this.#uuid(),
          name: fullName,
          children: [result.uuid],
          befores: [],
          afters: [],
          start: at,
          stop: at
        }
        this.#open.set(event.test, { result, container, stack: [], failures: [] })
        break
      }

      case 'test.skipped': {
        const entry = this.#open.get(event.test)
        if (!entry) break
        entry.result.status = 'skipped'
        entry.result.statusDetails = { message: event.reason }
        break
      }

      case 'step.started': {
        const at = this.clock()
        const step: AllureStep = {
          name: labelOf(event.stepId, event.stepType),
          status: 'passed',
          stage: 'finished',
          start: at,
          stop: at,
          steps: [],
          parameters: metaParameters(event.meta),
          attachments: []
        }
        const entry = this.#open.get(event.test ?? '')
        if (entry) {
          entry.stack.push(step)
          break
        }
        // No test: a suite's own setup or cleanup. It is held on the suite's
        // container rather than dropped, which is the one place `plugin-junit`
        // cannot follow — JUnit has nowhere to put it.
        if (event.suite) this.pendingSuiteStep(event.suite, event.phase).push(step)
        break
      }

      case 'step.finished': {
        const entry = this.#open.get(event.test ?? '')
        const step = entry ? entry.stack.pop() : this.lastSuiteStep(event.suite, event.phase)
        if (!step) break

        // The duration is the run's answer; the clock only says when. Reading
        // `stop` off the clock instead would make every step on a replay last
        // zero milliseconds, since a replay delivers the whole log at once.
        step.stop = step.start + event.durationMs
        step.status = statusOf(event.status)
        if (event.status !== 'passed' && event.status !== 'skipped') {
          step.statusDetails = { message: event.message ?? event.status, trace: trace(event.detail) }
        } else if (event.detail !== undefined) {
          // A passing step's own record is worth keeping and not worth a
          // failure-shaped field: it goes in as a parameter, where Allure
          // shows it folded away under the step.
          step.parameters.push({ name: 'detail', value: clip(render(event.detail)) })
        }

        if (!entry) break
        const parent = entry.stack.at(-1)
        if (parent) parent.steps.push(step)
        else entry.result.steps.push(step)
        if (event.status !== 'passed' && event.status !== 'skipped') {
          entry.failures.push({
            message: `step ${labelOf(event.stepId, event.stepType)}: ${event.message ?? event.status}`,
            trace: trace(event.detail)
          })
        }
        break
      }

      case 'assertion.evaluated': {
        const entry = this.#open.get(event.test ?? '')
        if (!entry) break
        const at = this.clock()
        // An assertion is a step in Allure's model and has nowhere else to
        // live: it is the leaf a reader opens a failing test to read.
        const step: AllureStep = {
          name: event.message,
          status: event.passed ? 'passed' : 'failed',
          stage: 'finished',
          start: at,
          stop: at,
          steps: [],
          parameters: event.passed
            ? []
            : [
                { name: 'expected', value: clip(render(event.expected)) },
                { name: 'actual', value: clip(render(event.actual)) }
              ],
          attachments: []
        }
        if (!event.passed) {
          step.statusDetails = { message: event.message, trace: diff(event.expected, event.actual) }
          entry.failures.push({
            message: `${event.assertionType}: ${event.message}`,
            trace: diff(event.expected, event.actual)
          })
        }
        // Under the step it checked, when it names one. A bare `assert:` block
        // names none and belongs to the test.
        const owner = event.stepId
          ? entry.result.steps.find((s) => s.name.startsWith(`${event.stepId} `) || s.name === event.stepId)
          : undefined
        ;(owner ? owner.steps : entry.result.steps).push(step)
        break
      }

      case 'artifact.attached': {
        const entry = this.#open.get(event.test ?? '')
        if (!entry) break
        // Only a written artifact can be carried across: the event says how
        // many bytes there were and never what they are, so a run with no
        // report directory has nothing to copy. Said plainly rather than
        // written as a broken link.
        if (!event.path) break
        const source = `${this.#uuid()}-attachment${extensionOf(event.path, event.contentType)}`
        this.#copies.push({ from: event.path, to: source })
        entry.result.attachments.push({ name: event.name, source, type: event.contentType })
        break
      }

      case 'test.finished': {
        const entry = this.#open.get(event.test)
        if (!entry) break
        this.#open.delete(event.test)
        const { result, container } = entry
        // Forwards from the start, never backwards from the finish: taking
        // `start = stop - durationMs` put a replayed test before the run that
        // contained it, which Allure's timeline draws exactly as absurdly as
        // it sounds.
        result.stop = result.start + event.durationMs
        result.status = statusOf(event.status)
        if (result.status !== 'passed' && result.status !== 'skipped') {
          result.statusDetails = merge(entry.failures)
        }
        container.start = result.start
        container.stop = result.stop
        this.#results.push(result)
        this.#containers.push(container)
        break
      }

      case 'run.finished':
        // Suite containers last, and only the ones that hold something: an
        // empty container is a heading in the report with nothing under it.
        for (const container of this.#suites.values()) {
          if (container.befores.length + container.afters.length > 0) this.#containers.push(container)
        }
        break
    }
  }

  reset(): void {
    this.#results = []
    this.#containers = []
    this.#copies = []
    this.#open = new Map()
    this.#suites = new Map()
    this.#runId = undefined
    this.#startedAt = 0
    this.#counter = 0
  }

  result(): AllureBundle {
    return {
      results: this.#results,
      containers: this.#containers,
      copies: this.#copies,
      startedAt: this.#startedAt,
      runId: this.#runId
    }
  }

  /** The run's own instant plus however long this reporter has been watching. */
  private clock(): number {
    return this.#startedAt + (this.#now() - this.#t0)
  }

  private labelsFor(
    event: Extract<RunEvent, { type: 'test.started' }>,
    suite: string
  ): AllureLabel[] {
    const labels: AllureLabel[] = [
      { name: 'framework', value: 'speqkit' },
      { name: 'suite', value: suite }
    ]
    if (event.source) labels.push({ name: 'testClass', value: event.source })
    // The `cases` row this test came from. Allure has no word for it, and
    // `subSuite` is the one that groups a parametrised set under its table.
    if (event.group) labels.push({ name: 'subSuite', value: event.group })
    for (const tag of event.tags ?? []) labels.push({ name: 'tag', value: tag })
    for (const [key, label] of Object.entries(this.#labels)) {
      const value = event.meta?.[key]
      if (value !== undefined && value !== null) labels.push({ name: label, value: String(value) })
    }
    return labels
  }

  private suiteFor(name: string, title?: string): AllureContainer {
    let container = this.#suites.get(name)
    if (!container) {
      container = {
        uuid: this.#uuid(),
        name: title ?? name,
        children: [],
        befores: [],
        afters: [],
        start: this.clock(),
        stop: this.clock()
      }
      this.#suites.set(name, container)
    }
    return container
  }

  private pendingSuiteStep(suite: string, phase: 'setup' | 'cleanup' | undefined): AllureStep[] {
    const container = this.suiteFor(suite)
    return phase === 'cleanup' ? container.afters : container.befores
  }

  private lastSuiteStep(suite: string | undefined, phase: 'setup' | 'cleanup' | undefined): AllureStep | undefined {
    if (!suite) return undefined
    return this.pendingSuiteStep(suite, phase).at(-1)
  }
}

/* ------------------------------------------------------------------ */
/* Small things the fold needs                                         */
/* ------------------------------------------------------------------ */

function labelOf(stepId: string | undefined, stepType: string): string {
  return stepId ? `${stepId} (${stepType})` : stepType
}

/**
 * A stable id for a name, without pulling in `node:crypto`.
 *
 * FNV-1a over the string, twice with different offsets, printed as hex. Allure
 * only asks that the id be the same for the same test and different for
 * different ones; a cryptographic hash would buy nothing and a random id would
 * cost the whole trend.
 */
export function hash(value: string): string {
  const fnv = (offset: number): string => {
    let h = offset
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return `${fnv(0x811c9dc5)}${fnv(0x01000193)}`
}

function metaParameters(meta: Record<string, unknown> | undefined): AllureParameter[] {
  return Object.entries(meta ?? {}).map(([name, value]) => ({ name, value: clip(render(value)) }))
}

/**
 * Everything in `meta` that did not become a label, and every `cases` column.
 *
 * Allure shows parameters in the test's header and uses them to tell two rows
 * of a parametrised table apart, which is exactly what a `cases` row is.
 */
function parametersFor(
  meta: Record<string, unknown> | undefined,
  labels: Record<string, string>
): AllureParameter[] {
  return Object.entries(meta ?? {})
    .filter(([key]) => !(key in labels) && key !== 'links' && key !== 'issue' && key !== 'tms')
    .map(([name, value]) => ({ name, value: clip(render(value)) }))
}

/**
 * `meta.issue`, `meta.tms` and `meta.links`, in Allure's link shape.
 *
 * A link is the one annotation a reader clicks, and a report that shows the
 * ticket id as a grey chip beside the test is a report that makes them go and
 * search for it.
 */
function linksFor(meta: Record<string, unknown> | undefined): AllureLink[] {
  const links: AllureLink[] = []
  const add = (value: unknown, type: string): void => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item.trim()) links.push({ name: item, url: item, type })
      else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        const url = typeof record.url === 'string' ? record.url : undefined
        if (url) {
          links.push({
            name: typeof record.name === 'string' ? record.name : url,
            url,
            type: typeof record.type === 'string' ? record.type : type
          })
        }
      }
    }
  }
  if (meta?.issue !== undefined) add(meta.issue, 'issue')
  if (meta?.tms !== undefined) add(meta.tms, 'tms')
  if (meta?.links !== undefined) add(meta.links, 'link')
  return links
}

/** The failures a test collected, as one message and one trace. */
function merge(failures: AllureStatusDetails[]): AllureStatusDetails | undefined {
  if (failures.length === 0) return undefined
  return {
    message: failures[0]!.message,
    trace: failures
      .map((f) => (f.trace ? `${f.message}\n${f.trace}` : f.message))
      .filter(Boolean)
      .join('\n\n')
  }
}

function trace(detail: unknown): string | undefined {
  if (detail === undefined) return undefined
  return clip(render(detail))
}

function diff(expected: unknown, actual: unknown): string | undefined {
  if (expected === undefined && actual === undefined) return undefined
  return `expected: ${clip(render(expected))}\nactual:   ${clip(render(actual))}`
}

function render(value: unknown): string {
  if (value === undefined) return '(nothing)'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A cap on anything a plugin recorded about itself.
 *
 * A `detail` is whatever the step type put there, and an HTTP step's is a
 * whole response body. Ten of those in one test is a result file a browser
 * takes a second to parse; a hundred is a report nobody opens twice.
 */
const LIMIT = 8000

function clip(value: string): string {
  return value.length <= LIMIT ? value : `${value.slice(0, LIMIT)}\n… ${value.length - LIMIT} more characters`
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv',
  'video/webm': '.webm',
  'video/mp4': '.mp4'
}

/**
 * Allure picks the viewer off the *file extension*, not off `type`.
 *
 * A screenshot copied in as `abc-attachment` renders as a download link and
 * not as a picture, which is the single thing anybody attaches one for. The
 * written file's own extension is trusted first, since the step that wrote it
 * knew what it was.
 */
export function extensionOf(path: string, contentType: string): string {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot > slash + 1) return path.slice(dot).toLowerCase()
  return EXTENSIONS[contentType.split(';')[0]!.trim().toLowerCase()] ?? '.txt'
}
