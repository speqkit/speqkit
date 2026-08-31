import type {
  AssertionDef, Diagnostic, InputSchema, StepDef, SuiteDef, TestDef, ValidateContext,
  ValidationProblem, Validator
} from '@speqkit/plugin-api'
import type { Registry, Registered } from './registry.js'

export type { Diagnostic }

/**
 * Validation runs before a single network call, because the kernel knows the
 * whole grammar: every step type and assertion the loaded plugins registered,
 * plus the schema each declared for its own inputs. A typo costs milliseconds
 * rather than a half-finished run against a real environment.
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
    if (suite.pending !== undefined && typeof suite.pending !== 'string') {
      diagnostics.push({
        file: where.file,
        path: 'pending',
        message: 'pending must say why',
        hint: 'it parks every test in the suite — write the gap that records'
      })
    }
  }

  for (const test of tests) {
    const file = test.source ?? '(unknown)'
    if (!test.name) {
      diagnostics.push({ file, path: 'name', message: 'test has no name' })
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
          message: `duplicate test name '${test.name}'`,
          hint: first === file
            ? ' — already used in this file; every event a run emits is keyed by the name'
            : ` — already used in ${first}; every event a run emits is keyed by the name`
        })
      } else {
        named.set(test.name, file)
      }
    }
    if (!Array.isArray(test.steps) || test.steps.length === 0) {
      diagnostics.push({ file, path: 'steps', message: 'test has no steps' })
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
        message: 'pending must say why',
        hint: 'a test parked without a reason is a test being deleted slowly — write the gap it records'
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
          message: `variable '${name}' is also a step id`,
          hint: `the step binds over the variable, so \${${name}} means the given before that step and the result after it`
        })
      }
    }
  }

  return diagnostics
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
        diagnostics.push({ file, path, message: `duplicate step id '${step.id}'` })
      }
      seen.add(step.id)
    }

    const entry = registry.stepTypes.get(step.type)
    if (!entry) {
      diagnostics.push({
        file,
        path: `${path}.type`,
        message: `unknown step type '${step.type}'`,
        hint: suggest(step.type, [...registry.stepTypes.keys()])
      })
      return
    }
    if (entry.def.schema) {
      for (const problem of checkSchema(step, entry.def.schema)) {
        diagnostics.push({ file, path, message: problem })
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
    diagnostics.push({ file, path: 'cases', message: 'cases must be a list' })
    return
  }
  if (table.length === 0) {
    diagnostics.push({
      file,
      path: 'cases',
      message: 'cases is empty, so this test never runs',
      hint: 'delete the table to run the test once, or write the rows'
    })
    return
  }

  const ids = new Set<string>()
  for (const [index, entry] of table.entries()) {
    const path = `cases[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push({ file, path, message: 'a case must be a mapping with an id' })
      continue
    }
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) {
      diagnostics.push({
        file,
        path: `${path}.id`,
        message: 'a case needs an id',
        hint: 'the id is the case\'s name — `name[id]` — and a position would move when a row is inserted above it'
      })
      continue
    }
    if (ids.has(id)) {
      diagnostics.push({ file, path: `${path}.id`, message: `duplicate case id '${id}'` })
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
        message: `unknown assertion '${assertion.type}'`,
        hint: suggest(assertion.type, [...registry.assertions.keys()])
      })
      continue
    }
    if (entry.def.schema) {
      for (const problem of checkSchema(assertion, entry.def.schema)) {
        diagnostics.push({ file: where.file, path, message: problem })
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
      message:
        `checking this ${kind} threw inside plugin '${entry.owner}': ` +
        (err instanceof Error ? err.message : String(err)),
      hint: 'this is a bug in the plugin, not in the test'
    })
    return
  }

  for (const problem of problems ?? []) {
    const { message, hint, path: inner } = typeof problem === 'string' ? { message: problem, hint: undefined, path: undefined } : problem
    diagnostics.push({
      file: where.file,
      path: inner ? `${path}.${inner}` : path,
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

/**
 * A deliberately small structural check: required keys, and unknown keys when
 * the schema closes itself. Full JSON Schema arrives with the installer, once
 * schemas are being generated from plugin builds rather than hand-written.
 */
function checkSchema(value: Record<string, unknown>, schema: InputSchema): string[] {
  const problems: string[] = []
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) problems.push(`missing required field '${key}'`)
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set([
      ...Object.keys(schema.properties), 'id', 'type', 'timeout', 'steps', 'assert', 'meta'
    ])
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        problems.push(`unknown field '${key}'${suggest(key, [...allowed]) ?? ''}`)
      }
    }
  }
  return problems
}

function suggest(input: string, known: string[]): string | undefined {
  const near = known
    .map((k) => [k, distance(input, k)] as const)
    .filter(([, d]) => d <= 2)
    .sort((a, b) => a[1] - b[1])[0]
  if (near) return ` — did you mean '${near[0]}'?`
  return known.length ? ` — available: ${known.sort().join(', ')}` : undefined
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[a.length]![b.length]!
}
