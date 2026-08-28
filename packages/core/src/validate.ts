import type { StepDef, TestDef, InputSchema } from '@speq/plugin-api'
import type { Registry } from './registry.js'

export interface Diagnostic {
  file: string
  path: string
  message: string
  hint?: string
}

/**
 * Validation runs before a single network call, because the kernel knows the
 * whole grammar: every step type and assertion the loaded plugins registered,
 * plus the schema each declared for its own inputs. A typo costs milliseconds
 * rather than a half-finished run against a real environment.
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

    const seen = new Set<string>()
    walkSteps(test.steps, 'steps', (step, path) => {
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
    })

    for (const [index, assertion] of (test.assert ?? []).entries()) {
      const path = `assert[${index}]`
      const entry = registry.assertions.get(assertion.type)
      if (!entry) {
        diagnostics.push({
          file,
          path: `${path}.type`,
          message: `unknown assertion '${assertion.type}'`,
          hint: suggest(assertion.type, [...registry.assertions.keys()])
        })
        continue
      }
      if (entry.def.schema) {
        for (const problem of checkSchema(assertion, entry.def.schema)) {
          diagnostics.push({ file, path, message: problem })
        }
      }
    }
  }

  return diagnostics
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
    const allowed = new Set([...Object.keys(schema.properties), 'id', 'type', 'timeout', 'steps'])
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
