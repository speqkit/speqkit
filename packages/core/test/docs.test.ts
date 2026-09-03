import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * What a reader finds out about a plugin they did not write.
 *
 * `speq plugins` says who is loaded. `speq capabilities` says what may be
 * written, with the schemas. Neither answers the question anybody actually has
 * a minute after `speq add`: what is this for, and what does one line of it
 * look like. That answer lived in a README on a website — a document the
 * session cannot ask, cannot check, and which is wrong the moment somebody
 * renames a step type.
 *
 * So this is driven the way the last gate was: a plugin from outside, plain
 * ESM against the published shapes, loaded by path, read by the real binary.
 * If a third-party plugin's own words cannot reach a reader, the feature is
 * for this repository only.
 */

const PLUGIN = `// A plugin from outside speqkit. Plain ESM against the published shapes.
export default {
  name: 'kettle',

  docs: {
    summary: 'boils water, and says when it is boiling',
    readme: 'https://example.com/kettle#readme',
    examples: [
      {
        title: 'boiling a litre',
        summary: 'The step hands back the temperature it reached.',
        for: ['kettle.boil', 'boiling'],
        code: ['- id: kettle', '  type: kettle.boil', '  litres: 1'].join('\\n')
      }
    ]
  },

  setup(ctx) {
    ctx.defineStepType('kettle.boil', {
      summary: 'heats water until it boils',
      schema: {
        type: 'object',
        properties: { litres: { type: 'number' } },
        required: ['litres'],
        additionalProperties: false
      },
      execute: (_exec, input) => ({ celsius: 100, litres: input.litres })
    })

    ctx.defineAssertion('boiling', {
      summary: 'the water reached 100C',
      evaluate: (assert) => ({ passed: assert.last?.celsius === 100, message: 'boiling' })
    })
  }
}
`

/** The same plugin with the one thing this command exists to require left out. */
const SILENT = PLUGIN
  .replace(/  docs: \{[\s\S]*?\n  \},\n\n/, '')
  .replace("name: 'kettle'", "name: 'silent'")
  // Renamed throughout: two plugins defining one word is a different
  // complaint, and it is the kernel's rather than this command's.
  .replaceAll('kettle.boil', 'silent.boil')
  .replaceAll("'boiling'", "'silently-boiling'")

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** Under examples/basic, where `yaml` and `cli` resolve the way they would anywhere. */
function project(plugins = [PLUGIN]): string {
  const dir = mkdtempSync(join(repo, 'examples/basic', 'speq-docs-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'suites'))
  const names = plugins.map((source, index) => {
    const file = `plugin-${index}.mjs`
    writeFileSync(join(dir, file), source)
    return `  - ./${file}`
  })
  writeFileSync(join(dir, 'speq.yaml'), `version: 1\nplugins:\n  - yaml\n  - cli\n${names.join('\n')}\n`)
  return dir
}

function speq(dir: string, argv: string[]): { code: number | null; output: string } {
  const result = spawnSync(
    'node',
    ['--import', 'tsx', join(repo, 'packages/core/src/bin.ts'), ...argv],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
  )
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('speq docs', () => {
  it('says what an outside plugin is for, without being told anything about it', () => {
    const { code, output } = speq(project(), ['docs'])

    expect(code).toBe(0)
    expect(output).toContain('kettle')
    expect(output).toContain('boils water, and says when it is boiling')
    // The capabilities it brought, so a reader can ask about one of them next.
    expect(output).toContain('kettle.boil')
    expect(output).toContain('https://example.com/kettle#readme')
  })

  it('hands over the example whole, so it can be pasted', () => {
    const { code, output } = speq(project(), ['docs', 'kettle'])

    expect(code).toBe(0)
    expect(output).toContain('boiling a litre')
    expect(output).toContain('- id: kettle')
    expect(output).toContain('  litres: 1')
  })

  /**
   * The lookup that makes an example findable rather than merely present: the
   * example says which capabilities it demonstrates, so asking about one of
   * them is a lookup and not a search through prose.
   */
  it('finds a capability by name, and the examples that name it', () => {
    const { code, output } = speq(project(), ['docs', 'boiling'])

    expect(code).toBe(0)
    expect(output).toContain('an assertion from kettle')
    expect(output).toContain('the water reached 100C')
    expect(output).toContain('boiling a litre')
  })

  it('shows a step type its schema, marking what is required', () => {
    const { output } = speq(project(), ['docs', 'kettle.boil'])

    expect(output).toContain('heats water until it boils')
    expect(output).toMatch(/\*\s+litres/)
  })

  it('refuses a name nothing loaded answers to, and says what is here', () => {
    const { code, output } = speq(project(), ['docs', 'toaster'])

    expect(code).toBe(2)
    expect(output).toContain('toaster')
    expect(output).toContain('kettle.boil')
  })

  it('answers as a document, for a reader that is not a person', () => {
    const { code, output } = speq(project(), ['docs', 'kettle', '--json'])

    expect(code).toBe(0)
    const entry = JSON.parse(output) as {
      name: string
      summary: string
      contributes: { name: string; kind: string; summary?: string }[]
      examples: { code: string; for?: string[] }[]
    }
    // The grammar and a working line of it, in one call. `capabilities --json`
    // has the schemas and no prose; this is the arrangement a model can act on.
    expect(entry.name).toBe('kettle')
    expect(entry.contributes.map((c) => c.name).sort()).toEqual(['boiling', 'kettle.boil'])
    expect(entry.contributes.find((c) => c.name === 'boiling')?.summary).toBe('the water reached 100C')
    expect(entry.examples[0]!.for).toContain('kettle.boil')
  })
})

describe('speq docs --check', () => {
  it('passes a project whose plugins all say what they are for', () => {
    const { code, output } = speq(project(), ['docs', '--check'])

    expect(code).toBe(0)
    expect(output).toContain('all of them say what they are for')
  })

  it('names a plugin that says nothing, and exits on it', () => {
    const { code, output } = speq(project([PLUGIN, SILENT]), ['docs', '--check'])

    expect(code).toBe(2)
    expect(output).toContain('silent')
    expect(output).toContain('declares no docs')
    // The one that is documented is not dragged into the complaint.
    expect(output).not.toContain('kettle: declares no docs')
  })

  /**
   * The whole anti-rot mechanism. A step type renamed with the examples left
   * behind is documentation that is confidently wrong, and it is the failure
   * mode a README on a website has no way to notice.
   */
  it('catches an example that demonstrates something no longer there', () => {
    const renamed = PLUGIN.replace("ctx.defineStepType('kettle.boil'", "ctx.defineStepType('kettle.heat'")
    const { code, output } = speq(project([renamed]), ['docs', '--check'])

    expect(code).toBe(2)
    expect(output).toContain("says it shows 'kettle.boil'")
    expect(output).toContain('which nothing loaded defines')
  })

  it('reports a capability no example demonstrates without failing on it', () => {
    const extra = PLUGIN.replace(
      "    ctx.defineAssertion('boiling'",
      "    ctx.defineStepType('kettle.descale', { execute: () => ({ done: true }) })\n\n    ctx.defineAssertion('boiling'"
    )
    const { code, output } = speq(project([extra]), ['docs', '--check'])

    // Some capabilities genuinely need no example, and turning that into a
    // failure would buy an example per entry rather than an example worth
    // reading. Reported, and it changes nothing.
    expect(code).toBe(0)
    expect(output).toContain('kettle.descale')
    expect(output).toContain('no example demonstrates')
  })
})
