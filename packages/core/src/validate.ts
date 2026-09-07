import type {
  AssertionDef, Diagnostic, InputSchema, StepDef, SuiteDef, TestDef, ValidateContext,
  ValidationProblem, Validator
} from '@speqkit/plugin-api'
import { shortName, type Registry, type Registered } from './registry.js'
import { checkAgainstSchema, distance } from './schema.js'
import { readTimeout } from './executor.js'

export type { Diagnostic }

/**
 * Validation runs before a single network call, because the kernel knows the
 * whole grammar: every step type and assertion the loaded plugins registered,
 * plus the schema each declared for its own inputs. A typo costs milliseconds
 * rather than a half-finished run against a real environment.
 *
 * Every diagnostic carries a `code` as well as a message, and the two are for
 * different readers: the message is a sentence and may be reworded in any
 * release, the code is a slug and may not. The kernel's are the bare words
 * below; a problem a plugin's own `validate` returned is prefixed with that
 * plugin's short name, so no plugin can ever take a code the kernel means to
 * use later.
 *
 * A schema settles shape and nothing else, so a plugin may also contribute a
 * `validate` of its own — whether the schema file an assertion names exists,
 * whether two fields that exclude each other are both set. The kernel keeps
 * the walk and the addressing: a plugin returns messages, never a location it
 * could get wrong.
 */
export function validateTests(registry: Registry, tests: TestDef[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  /** Where each name was first seen, so the second one can say where to look. */
  const named = new Map<string, string>()

  // A suite's setup is steps, written by the same hand and just as able to
  // name a step type that does not exist. Checked once per suite however many
  // tests are under it, and before the run rather than in the middle of it:
  // a suite whose setup cannot start blocks every test below.
  for (const suite of distinctSuites(tests)) {
    const where = { suite, file: suite.source ?? '(unknown)' }
    const visit = stepVisitor(diagnostics, registry, where)
    walkSteps(suite.setup ?? [], 'setup', visit)
    walkSteps(suite.cleanup ?? [], 'cleanup', visit)
    checkReferences(diagnostics, registry, { setup: suite.setup, cleanup: suite.cleanup }, where.file)
    if (suite.pending !== undefined && typeof suite.pending !== 'string') {
      diagnostics.push({
        file: where.file,
        path: 'pending',
        code: 'pending-needs-reason',
        message: 'pending must say why',
        hint: 'it parks every test in the suite — write the gap that records'
      })
    }
  }

  for (const test of tests) {
    const file = test.source ?? '(unknown)'
    if (!test.name) {
      diagnostics.push({ file, path: 'name', code: 'test-has-no-name', message: 'test has no name' })
    } else {
      // Every event a run emits is keyed by this name, and nothing checked it
      // was unique. Two tests sharing one made a report where the second
      // overwrote the first — one line instead of two, with no sign that
      // anything had been lost. It costs more once a name is generated rather
      // than typed, which is where parametrization is going.
      const first = named.get(test.name)
      if (first !== undefined) {
        diagnostics.push({
          file,
          path: 'name',
          code: 'duplicate-test-name',
          message: `duplicate test name '${test.name}'`,
          hint: first === file
            ? 'already used in this file; every event a run emits is keyed by the name'
            : `already used in ${first}; every event a run emits is keyed by the name`
        })
      } else {
        named.set(test.name, file)
      }
    }
    if (!Array.isArray(test.steps) || test.steps.length === 0) {
      diagnostics.push({ file, path: 'steps', code: 'test-has-no-steps', message: 'test has no steps' })
      continue
    }

    // Checked, not excused. A pending test is precisely the one nobody runs
    // and therefore the one that rots into an invalid step type unnoticed;
    // skipping validation for it would make the entry worthless by the time
    // somebody comes back to it.
    if (test.pending !== undefined && typeof test.pending !== 'string') {
      diagnostics.push({
        file,
        path: 'pending',
        code: 'pending-needs-reason',
        message: 'pending must say why',
        hint: 'a test parked without a reason is a test being deleted slowly — write the gap it records'
      })
    }

    if (test.timeout !== undefined && readTimeout(test.timeout) === undefined) {
      diagnostics.push({
        file,
        path: 'timeout',
        code: 'invalid-value',
        message: `timeout must be a number of milliseconds or a duration like '30s', not ${JSON.stringify(test.timeout)}`
      })
    }

    // The safety net under `meta`. The design is right — a label a plugin
    // invents must not need the kernel's permission — and its cost is that a
    // key which changes nothing is accepted in silence. `timeout:` was the
    // proof: it read as an annotation, was carried and never read, and
    // `1 test(s) valid` said so. It is a field of the spine now; the rest of
    // this list is every word somebody reaches for next.
    for (const key of Object.keys(test.meta ?? {})) {
      const instead = BEHAVIOURAL[key.toLowerCase()]
      if (!instead) continue
      diagnostics.push({
        file,
        path: `meta.${key}`,
        level: 'warn',
        code: 'meta-looks-like-behaviour',
        message: `'${key}' is an annotation here, which means it is carried and never read`,
        hint: instead
      })
    }

    const seen = new Set<string>()
    const visit = stepVisitor(diagnostics, registry, { test, file }, seen)

    // Setup and cleanup are steps and get the same grammar, addressed by the
    // phase they were written in so the diagnostic points at the right block.
    walkSteps(test.setup ?? [], 'setup', visit)
    walkSteps(test.steps, 'steps', visit)
    walkSteps(test.cleanup ?? [], 'cleanup', visit)

    checkAssertions(diagnostics, registry, test.assert, { test, file }, '')

    checkReferences(diagnostics, registry, test, file)

    // A `cases` table that survived discovery unexpanded is a table the kernel
    // could not turn into tests. It is reported here rather than there because
    // discovery has nowhere to say anything, and because once a table has
    // become five tests there is nothing left to point at.
    reportBadCases(diagnostics, test, file)

    // A variable and a step result live in one namespace — that is what makes
    // `${slug}` and `${login.body.id}` read the same way — so a step that
    // binds over a given silently changes what every later `${name}` means.
    for (const name of Object.keys(test.variables ?? {})) {
      if (seen.has(name)) {
        diagnostics.push({
          file,
          path: `variables.${name}`,
          code: 'variable-is-a-step-id',
          message: `variable '${name}' is also a step id`,
          hint: `the step binds over the variable, so \${${name}} means the given before that step and the result after it`
        })
      }
    }
  }

  return diagnostics
}

/**
 * A piece of a test, checked against the grammar on its own.
 *
 * What `speq docs --check` runs over an example: a list of steps, an `assert:`
 * block, a `setup:` — whatever a plugin author pasted into `docs.examples`.
 * It is the same walk as `validateTests`, minus everything that is about a
 * whole test — a name, a non-empty body, the `cases` table — because a
 * fragment has none of those and should not be told to.
 *
 * `file` is what the diagnostics name, since a fragment has no file: the
 * plugin and the example's title, so the complaint says where to look.
 */
export interface Fragment {
  setup?: StepDef[]
  steps?: StepDef[]
  assert?: AssertionDef[]
  cleanup?: StepDef[]
}

export function validateFragment(registry: Registry, fragment: Fragment, file: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const where: Where = { file }
  const visit = stepVisitor(diagnostics, registry, where)
  walkSteps(fragment.setup ?? [], 'setup', visit)
  walkSteps(fragment.steps ?? [], 'steps', visit)
  walkSteps(fragment.cleanup ?? [], 'cleanup', visit)
  checkAssertions(diagnostics, registry, fragment.assert, where, '')
  return diagnostics
}

/* ------------------------------------------------------------------ */
/* `${…}` before the run                                                */
/* ------------------------------------------------------------------ */

/**
 * Every `${…}` a test writes, read against what the test binds.
 *
 * The bet the project rests on is that a generated test can be checked before
 * it runs, and until this the check stopped at the words: a step type and its
 * fields. The *joins* — the name of the step above, the given declared at the
 * top, the provider a prefix asks — were found out at run time, as an errored
 * step, and a model gets those wrong more often than it misspells `http`.
 *
 * What the kernel knows for certain: a test's givens, bound in order, each
 * visible to the one below it; the id of every step, visible to every step
 * after it and to the assertions and cleanup; and which value providers are
 * loaded. So a reference to a name that is none of those is a diagnostic —
 * `unresolved-reference`, or `forward-reference` when the name is a step
 * further down, because that one has a sentence of its own. A prefix nothing
 * loaded answers is `unknown-provider`, whichever scope it is written in,
 * because a provider does not come from scope.
 *
 * What the kernel cannot know is what a nesting step binds for the steps
 * under it — `loop` binds `as`, and a step type this repository has never
 * seen binds whatever it likes. A step type says so with `StepTypeDef.binds`,
 * and one that nests and says nothing is taken at its word: nothing is
 * reported under it. Strict where the grammar is the kernel's, silent where
 * it is not, and never a diagnostic about a name that would have resolved.
 *
 * Only the head of a path is checked. `${order.body.total}` names a step the
 * kernel can see and a shape only the run produces; a wrong `total` is still
 * the run's to find, and the assertion's message says what was there.
 */
function checkReferences(
  diagnostics: Diagnostic[],
  registry: Registry,
  subject: Partial<Pick<TestDef, 'variables' | 'setup' | 'steps' | 'assert' | 'cleanup'>>,
  file: string
): void {
  const providers = new Set([...registry.valueProviders.values()].map((p) => p.def.prefix))
  providers.add('meta')
  /** Every step id in the subject, and for a nested one the step it is under. */
  const everyId = new Map<string, StepDef | undefined>()
  const collect = (steps: StepDef[] | undefined, under: StepDef | undefined): void => {
    for (const step of steps ?? []) {
      if (step.id && !everyId.has(step.id)) everyId.set(step.id, under)
      collect(step.steps, step)
    }
  }
  collect(subject.setup, undefined)
  collect(subject.steps, undefined)
  collect(subject.cleanup, undefined)

  const names = new Set<string>()
  const scope: Scope = { names, open: false }

  const found = (path: string, expression: string, inScope: Scope, self?: string): void => {
    const colon = expression.indexOf(':')
    const prefix = colon > 0 ? expression.slice(0, colon) : undefined
    if (prefix !== undefined && PREFIX.test(prefix)) {
      if (!providers.has(prefix)) {
        diagnostics.push({
          file,
          path,
          code: 'unknown-provider',
          message: `\${${expression}} asks a value provider nothing loaded claims: '${prefix}'`,
          hint: providerHint(prefix, providers)
        })
      }
      return
    }
    if (inScope.open) return
    const head = expression.replace(/\[(\d+)\]/g, '.$1').split('.')[0]?.trim()
    if (!head || inScope.names.has(head)) return
    if (head === self) {
      diagnostics.push({
        file,
        path,
        code: 'forward-reference',
        message: `\${${expression}} names this step's own result, which does not exist until it has run`,
        hint: "a step's input cannot read its result; its `assert:` block can"
      })
      return
    }
    if (everyId.has(head)) {
      const under = everyId.get(head)
      diagnostics.push(under
        ? {
            file,
            path,
            code: 'unresolved-reference',
            message: `\${${expression}} names step '${head}', which is nested under ` +
              `${under.id ? `'${under.id}'` : `a '${under.type}' step`} and not visible outside it`,
            hint: 'a nested scope is popped when its step returns; read what the outer step publishes' +
              (under.id ? `, \${${under.id}.…}` : '')
          }
        : {
            file,
            path,
            code: 'forward-reference',
            message: `\${${expression}} names step '${head}', which runs after this`,
            hint: 'a step can read only what ran before it; move the step up, or the reference down'
          })
      return
    }
    diagnostics.push({
      file,
      path,
      code: 'unresolved-reference',
      message: `\${${expression}}: '${head}' is not defined here`,
      hint: nameHint(head, inScope.names)
    })
  }

  for (const [name, value] of Object.entries(subject.variables ?? {})) {
    walkTemplates(value, `variables.${name}`, (path, expression) => found(path, expression, scope))
    names.add(name)
  }
  const visit = (steps: StepDef[] | undefined, at: string, inScope: Scope): void => {
    for (const [index, step] of (steps ?? []).entries()) {
      const here = `${at}[${index}]`
      for (const [key, value] of Object.entries(step)) {
        if (key === 'steps' || key === 'assert' || key === 'meta' || key === 'type' || key === 'id') continue
        walkTemplates(value, `${here}.${key}`, (path, expression) => found(path, expression, inScope, step.id))
      }
      if (Array.isArray(step.steps)) {
        const def = registry.stepTypes.get(step.type)?.def
        const bound = def?.binds?.(step)
        const inner: Scope = {
          names: new Set([...inScope.names, ...(bound ?? [])]),
          open: inScope.open || !def?.binds
        }
        visit(step.steps, `${here}.steps`, inner)
      }
      // Bound before its own assertions run, so a step may address itself.
      if (step.id) inScope.names.add(step.id)
      for (const [index, assertion] of (step.assert ?? []).entries()) {
        walkTemplates(assertion, `${here}.assert[${index}]`, (path, expression) => found(path, expression, inScope))
      }
    }
  }
  visit(subject.setup, 'setup', scope)
  visit(subject.steps, 'steps', scope)
  for (const [index, assertion] of (subject.assert ?? []).entries()) {
    walkTemplates(assertion, `assert[${index}]`, (path, expression) => found(path, expression, scope))
  }
  visit(subject.cleanup, 'cleanup', scope)
}

interface Scope {
  names: Set<string>
  /** True under a nesting step that did not say what it binds. */
  open: boolean
}

const TEMPLATE = /\$\{([^}]+)\}/g
const PREFIX = /^[A-Za-z_][\w-]*$/

/** Every `${…}` in a value, with the path it was written at. */
function walkTemplates(value: unknown, path: string, on: (path: string, expression: string) => void): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TEMPLATE)) on(path, match[1]!.trim())
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkTemplates(item, `${path}[${index}]`, on))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkTemplates(item, `${path}.${key}`, on)
  }
}

function providerHint(prefix: string, loaded: Set<string>): string {
  const known = [...loaded].filter((p) => p !== 'meta').sort()
  const from = new Set(['env', 'gen', 'vars']).has(prefix) ? `'${prefix}:' comes from @speqkit/plugin-data; ` : ''
  return `${from}loaded: ${known.length ? known.join(', ') : '(none)'}`
}

function nameHint(head: string, names: Set<string>): string {
  const known = [...names].sort()
  const near = suggest(head, known)
  if (near?.startsWith('did you mean')) return near
  return known.length ? `defined here: ${known.join(', ')}` : 'nothing is defined here yet — a given, or a step with an id above'
}

/** The subject a diagnostic is about: a test, or a suite that declares steps. */
interface Where {
  test?: TestDef
  suite?: SuiteDef
  file: string
}

/**
 * The grammar check for one step, wherever it was written.
 *
 * `seen` is passed in rather than made here because duplicate ids are a
 * property of the block they share — a test's steps, or a suite's — and two
 * suites naming a step `login` are not a collision.
 */
function stepVisitor(
  diagnostics: Diagnostic[],
  registry: Registry,
  where: Where,
  seen: Set<string> = new Set()
): (step: StepDef, path: string) => void {
  const file = where.file
  return (step, path) => {
    if (step.id) {
      if (seen.has(step.id)) {
        diagnostics.push({ file, path, code: 'duplicate-step-id', message: `duplicate step id '${step.id}'` })
      }
      seen.add(step.id)
    }

    // A condition is a template or a literal boolean. A list or a mapping here
    // is somebody reaching for an expression language that does not exist, and
    // it would otherwise be true — because everything that is not one of the
    // dull false values is.
    if (step.when !== undefined && typeof step.when !== 'string' && typeof step.when !== 'boolean') {
      diagnostics.push({
        file,
        path: `${path}.when`,
        code: 'invalid-value',
        message: `'when' takes a template or true/false, not ${Array.isArray(step.when) ? 'a list' : typeof step.when}`,
        hint: 'write the condition as a value the test already binds, like ${created.body.draft}'
      })
    }

    const entry = registry.stepTypes.get(step.type)
    if (!entry) {
      diagnostics.push({
        file,
        path: `${path}.type`,
        code: 'unknown-step-type',
        message: `unknown step type '${step.type}'`,
        hint: suggest(step.type, [...registry.stepTypes.keys()])
      })
      return
    }
    if (entry.def.schema) {
      for (const problem of checkAgainstSchema(step, entry.def.schema, STEP_RESERVED)) {
        diagnostics.push({ file, path: problem.path ? `${path}.${problem.path}` : path, code: problem.code, message: problem.message })
      }
    }
    contribute(diagnostics, registry, entry, step, where, path, 'step type')

    // A step's own assertions are checked exactly like a test's: they are
    // the same `Assertion` of the model, written one level down.
    checkAssertions(diagnostics, registry, step.assert, where, path)
  }
}

/** Each declared suite once, however many tests carry it. */
function distinctSuites(tests: TestDef[]): SuiteDef[] {
  const out = new Map<string, SuiteDef>()
  for (const test of tests) {
    for (const suite of test.suites ?? []) if (!out.has(suite.name)) out.set(suite.name, suite)
  }
  return [...out.values()]
}

/**
 * What a `cases` table has to be before it can become tests.
 *
 * Every one of these leaves the table on the test rather than expanding it,
 * so the run does not start — which is the point. A table with two rows
 * called `eur` would otherwise be two tests with one name, and the second
 * would overwrite the first in every report.
 */
function reportBadCases(diagnostics: Diagnostic[], test: TestDef, file: string): void {
  const table = test.cases
  if (table === undefined) return

  if (!Array.isArray(table)) {
    diagnostics.push({ file, path: 'cases', code: 'cases-is-not-a-list', message: 'cases must be a list' })
    return
  }
  if (table.length === 0) {
    diagnostics.push({
      file,
      path: 'cases',
      code: 'cases-is-empty',
      message: 'cases is empty, so this test never runs',
      hint: 'delete the table to run the test once, or write the rows'
    })
    return
  }

  const ids = new Set<string>()
  for (const [index, entry] of table.entries()) {
    const path = `cases[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push({
        file, path, code: 'case-is-not-a-mapping', message: 'a case must be a mapping with an id'
      })
      continue
    }
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) {
      diagnostics.push({
        file,
        path: `${path}.id`,
        code: 'case-has-no-id',
        message: 'a case needs an id',
        hint: 'the id is the case\'s name — `name[id]` — and a position would move when a row is inserted above it'
      })
      continue
    }
    if (ids.has(id)) {
      diagnostics.push({
        file, path: `${path}.id`, code: 'duplicate-case-id', message: `duplicate case id '${id}'`
      })
    }
    ids.add(id)
  }
}

/** Checks one `assert:` block — a test's or a step's — against the grammar. */
function checkAssertions(
  diagnostics: Diagnostic[],
  registry: Registry,
  block: AssertionDef[] | undefined,
  where: Where,
  prefix: string
): void {
  for (const [index, assertion] of (block ?? []).entries()) {
    const path = prefix ? `${prefix}.assert[${index}]` : `assert[${index}]`
    const entry = registry.assertions.get(assertion.type)
    if (!entry) {
      diagnostics.push({
        file: where.file,
        path: `${path}.type`,
        code: 'unknown-assertion',
        message: `unknown assertion '${assertion.type}'`,
        hint: suggest(assertion.type, [...registry.assertions.keys()])
      })
      continue
    }
    if (entry.def.schema) {
      for (const problem of checkAgainstSchema(assertion, entry.def.schema, ASSERTION_RESERVED)) {
        diagnostics.push({ file: where.file, path: problem.path ? `${path}.${problem.path}` : path, code: problem.code, message: problem.message })
      }
    }
    contribute(diagnostics, registry, entry, assertion, where, path, 'assertion')
  }
}

/**
 * Runs one plugin's own check and files what it says.
 *
 * The throw is caught rather than allowed out. A validator runs in front of
 * every `speq run`, and a plugin with a bug in one would otherwise take down
 * validation for the whole suite — including the diagnostics that would have
 * told the user what was actually wrong.
 */
function contribute<T extends StepDef | AssertionDef>(
  diagnostics: Diagnostic[],
  registry: Registry,
  entry: Registered<{ validate?: Validator<T> }>,
  subject: T,
  where: Where,
  path: string,
  kind: string
): void {
  if (!entry.def.validate) return

  const ctx: ValidateContext = {
    ...(where.test ? { test: where.test } : {}),
    ...(where.suite ? { suite: where.suite } : {}),
    file: where.file,
    config: () => registry.configFor(entry.owner) as never
  }

  let problems: (string | ValidationProblem)[] | void
  try {
    problems = entry.def.validate(subject, ctx)
  } catch (err) {
    diagnostics.push({
      file: where.file,
      path,
      code: 'plugin-check-threw',
      message:
        `checking this ${kind} threw inside plugin '${entry.owner}': ` +
        (err instanceof Error ? err.message : String(err)),
      hint: 'this is a bug in the plugin, not in the test'
    })
    return
  }

  for (const problem of problems ?? []) {
    const { message, hint, path: inner, code } =
      typeof problem === 'string'
        ? { message: problem, hint: undefined, path: undefined, code: undefined }
        : problem
    diagnostics.push({
      file: where.file,
      path: inner ? `${path}.${inner}` : path,
      // Namespaced by the plugin that found it, always — including when the
      // plugin named nothing. A caller can then tell whose check refused
      // without reading the sentence, and a plugin that starts naming its
      // problems tomorrow does not collide with a kernel code invented today.
      code: `${shortName(entry.owner)}/${code ?? 'invalid'}`,
      message,
      ...(hint ? { hint } : {})
    })
  }
}

function walkSteps(steps: StepDef[], path: string, visit: (s: StepDef, p: string) => void): void {
  for (const [index, step] of steps.entries()) {
    const here = `${path}[${index}]`
    visit(step, here)
    if (Array.isArray(step.steps)) walkSteps(step.steps, `${here}.steps`, visit)
  }
}

/** What the kernel owns on a step, whatever the step type's schema says. */
/**
 * Words that read as behaviour, and where the behaviour actually is.
 *
 * Not a list of everything anybody might annotate with — that is the whole
 * point of `meta` — but of the handful whose *name* is a promise the file does
 * not keep. Each one names what to write instead, because a warning that only
 * says "this does nothing" leaves the reader exactly where they were.
 */
const BEHAVIOURAL: Record<string, string> = {
  timeout: "write it on the test itself: 'timeout: 30s' is a field of the spine",
  retries: "there is no test-level retry — wrap the steps in a 'retry' step (@speqkit/plugin-loop)",
  retry: "there is no test-level retry — wrap the steps in a 'retry' step (@speqkit/plugin-loop)",
  skip: "write 'pending:' with the reason, which is checked and reported as skipped",
  only: "there is no 'only' — select with 'speq run --name' or '--tags' so nothing is left focused in a commit",
  before: "write the steps under 'setup:', or in the suite's manifest for all of them",
  after: "write the steps under 'cleanup:', which runs whatever happened above it",
  depends: 'there is no ordering between tests — a test that needs a world builds it in its own setup',
  when: "'when:' is a field of a step, not of a test — write it on the steps it applies to"
}

const STEP_RESERVED = ['id', 'type', 'timeout', 'when', 'steps', 'assert', 'meta'] as const
/** And on an assertion, which has neither an id nor children. */
const ASSERTION_RESERVED = ['type', 'meta'] as const

/**
 * A sentence, not a suffix. A hint used to begin with the dash the console
 * prints between message and hint, and the dash rode into `validate --json`
 * as the first three characters of every `hint` — punctuation from one
 * surface leaking into a document read by another. The surface that joins
 * the two writes the separator; the hint says what it has to say.
 */
function suggest(input: string, known: string[]): string | undefined {
  const near = known
    .map((k) => [k, distance(input, k)] as const)
    .filter(([, d]) => d <= 2)
    .sort((a, b) => a[1] - b[1])[0]
  if (near) return `did you mean '${near[0]}'?`
  return known.length ? `available: ${known.sort().join(', ')}` : undefined
}

