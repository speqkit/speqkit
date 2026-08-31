import type {
  AssertionDef, Diagnostic, InputSchema, StepDef, TestDef, ValidateContext, ValidationProblem, Validator
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

  for (const test of tests) {
    const file = test.source ?? '(unknown)'
    if (!test.name) {
      diagnostics.push({ file, path: 'name', message: 'test has no name' })
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
    const visit = (step: StepDef, path: string) => {
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
      contribute(diagnostics, registry, entry, step, { test, file }, path, 'step type')

      // A step's own assertions are checked exactly like a test's: they are
      // the same `Assertion` of the model, written one level down.
      checkAssertions(diagnostics, registry, step.assert, { test, file }, path)
    }

    // Setup and cleanup are steps and get the same grammar, addressed by the
    // phase they were written in so the diagnostic points at the right block.
    walkSteps(test.setup ?? [], 'setup', visit)
    walkSteps(test.steps, 'steps', visit)
    walkSteps(test.cleanup ?? [], 'cleanup', visit)

    checkAssertions(diagnostics, registry, test.assert, { test, file }, '')

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

/** Checks one `assert:` block — a test's or a step's — against the grammar. */
function checkAssertions(
  diagnostics: Diagnostic[],
  registry: Registry,
  block: AssertionDef[] | undefined,
  where: { test: TestDef; file: string },
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
  where: { test: TestDef; file: string },
  path: string,
  kind: string
): void {
  if (!entry.def.validate) return

  const ctx: ValidateContext = {
    test: where.test,
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
