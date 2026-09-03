import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { definePlugin, type CommandDef, type CommandHost } from '@speqkit/plugin-api'
import { harness, type Harness } from '@speqkit/test-kit'
import use from '@speqkit/plugin-use'

/**
 * Written the way a third-party author would write them: through
 * `@speqkit/test-kit`, against the real kernel, with no reference to its
 * internals. The one thing these tests need that a protocol plugin does not is
 * a project on disk — blocks, modules and fixtures are files.
 */

let kit: Harness
let root: string

const calls: string[] = []

/** Something for a block to be made of. `fail` is how a block is given a reason to stop. */
const api = definePlugin({
  name: 'api',
  setup(ctx) {
    ctx.defineStepType('call', {
      execute(_exec, input) {
        calls.push(String(input.path))
        return { path: input.path, body: { id: `id-of-${String(input.path)}` }, status: 201 }
      }
    })
    ctx.defineAssertion('status', {
      evaluate: (assert, input) => ({
        passed: assert.last?.status === input.expected,
        message: `status ${String(assert.last?.status)}`
      })
    })
  }
})

function write(relative: string, content: string): void {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  calls.length = 0
  root = mkdtempSync(join(tmpdir(), 'speq-use-'))
})

afterEach(async () => {
  await kit.close()
  rmSync(root, { recursive: true, force: true })
})

describe('a shared block', () => {
  beforeEach(() => {
    write('shared/register-tenant.yaml', `
steps:
  - id: tenant
    type: call
    path: /auth/register
  - id: restaurants
    type: call
    path: /restaurants
`)
  })

  it('publishes its steps to the caller, addressed through the step that used it', async () => {
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({ id: 'setup', type: 'use', ref: 'register-tenant.yaml' })

    expect(step.status).toBe('passed')
    expect(calls).toEqual(['/auth/register', '/restaurants'])
    const echo = await kit.step({ type: 'call', path: '${setup.tenant.body.id}' })
    expect(echo.result.path).toBe('id-of-/auth/register')
  })

  it('publishes only what it declares, once it declares anything', async () => {
    write('shared/curated.yaml', `
steps:
  - id: tenant
    type: call
    path: /auth/register
returns:
  token: "\${tenant.body.id}"
`)
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({ id: 'setup', type: 'use', ref: 'curated' })

    expect(step.result).toEqual({ token: 'id-of-/auth/register' })
  })

  it('takes the file from the shared directory, or from the root when the path says so', async () => {
    write('blocks/elsewhere.yaml', `steps: [{ id: one, type: call, path: /elsewhere }]`)
    kit = await harness(use, { with: [api], root })

    await kit.step({ type: 'use', ref: 'blocks/elsewhere.yaml' })
    expect(calls).toEqual(['/elsewhere'])
  })

  it('stops and names the step that broke, rather than reporting the block as fine', async () => {
    write('shared/breaks.yaml', `
steps:
  - id: first
    type: call
    path: /ok
  - id: second
    type: call
    path: /wrong
    assert:
      - type: status
        expected: 500
  - id: third
    type: call
    path: /never
`)
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({ type: 'use', ref: 'breaks' })

    expect(step.status).toBe('error')
    expect(step.message).toContain("'second'")
    expect(calls).toEqual(['/ok', '/wrong'])
  })
})

describe('a module action', () => {
  beforeEach(() => {
    write('modules/auth.yaml', `
actions:
  login:
    properties: [email]
    steps:
      - id: logged_in
        type: call
        path: "/auth/login/\${email}"
    returns:
      token: "\${logged_in.body.id}"
  ping:
    steps:
      - id: pinged
        type: call
        path: /ping
`)
  })

  it('takes its properties as variables and hands back only what it returns', async () => {
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({
      id: 'session', type: 'use', action: 'auth.login', properties: { email: 'ada@example.com' }
    })

    expect(calls).toEqual(['/auth/login/ada@example.com'])
    expect(step.result).toEqual({ token: 'id-of-/auth/login/ada@example.com' })
  })

  it('keeps its internals to itself: the caller cannot address a step inside it', async () => {
    kit = await harness(use, { with: [api], root })
    await kit.step({ id: 'session', type: 'use', action: 'auth.login', properties: { email: 'a@b.c' } })

    const leaked = await kit.step({ type: 'call', path: '${logged_in.body.id}' })
    expect(leaked.status).toBe('error')
    expect(leaked.message).toContain('logged_in')
  })

  it('publishes its steps by id when it declares no returns', async () => {
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({ id: 'p', type: 'use', action: 'auth.ping' })

    expect(step.result).toMatchObject({ pinged: { status: 201 } })
  })
})

describe('a fixture', () => {
  beforeEach(() => {
    write('fixtures/menu-item.yaml', `
fixture:
  build:
    name: "generated-name"
    description: "generated-description"
`)
  })

  it('is a call like any other, except that what it hands back is data', async () => {
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({ id: 'item', type: 'use', fixture: 'menu-item' })

    expect(step.result).toEqual({ name: 'generated-name', description: 'generated-description' })
  })

  it('lets the caller pin the one field it means to assert on', async () => {
    kit = await harness(use, { with: [api], root })
    const step = await kit.step({
      id: 'item', type: 'use', fixture: 'menu-item.yaml', overrides: { name: 'speq-item' }
    })

    expect(step.result).toEqual({ name: 'speq-item', description: 'generated-description' })
  })
})

describe('what it refuses before the run', () => {
  beforeEach(() => {
    write('modules/auth.yaml', `
actions:
  login:
    properties: [email, password]
    steps: [{ id: one, type: call, path: /auth }]
`)
    write('shared/ok.yaml', `steps: [{ id: one, type: call, path: /ok }]`)
  })

  const check = async (step: Record<string, unknown>) => {
    kit = await harness(use, { with: [api], root })
    return kit.host.validate([{ name: 't', source: 'suites/t.yaml', steps: [step as never] }])
  }

  it('a block that is not on disk', async () => {
    const diagnostics = await check({ type: 'use', ref: 'missing' })
    expect(diagnostics[0]!.path).toBe('steps[0].ref')
    expect(diagnostics[0]!.message).toContain('no such block')
  })

  it('an action the module does not have, listing the ones it does', async () => {
    const diagnostics = await check({ type: 'use', action: 'auth.logout', properties: {} })
    expect(diagnostics[0]!.message).toContain("has no action 'logout'")
    expect(diagnostics[0]!.message).toContain('login')
  })

  it('an action called without the properties it declares', async () => {
    const diagnostics = await check({ type: 'use', action: 'auth.login', properties: { email: 'a@b.c' } })
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.message).toContain("needs 'password'")
  })

  it('two forms at once, because a step calls one thing', async () => {
    const diagnostics = await check({ type: 'use', ref: 'ok', action: 'auth.login' })
    expect(diagnostics[0]!.message).toContain('exclude each other')
  })

  it('a path written the way v1 wrote it, with the fix in the hint', async () => {
    const diagnostics = await check({ type: 'use', ref: '../../../shared/ok.yaml' })
    expect(diagnostics[0]!.message).toContain('relative to the test file')
    expect(diagnostics[0]!.hint).toContain('project root')
  })

  it("'as', which is v1 for naming a result — and says what to write instead", async () => {
    const diagnostics = await check({ type: 'use', ref: 'ok', as: 'tenant' })

    // The kernel rejects the unknown field because the schema is closed; the
    // plugin is what turns that into a migration instruction.
    expect(diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining("unknown field 'as'"))
    const migration = diagnostics.find((d) => d.path === 'steps[0].as')!
    expect(migration.hint).toContain("'id'")
  })
})

/**
 * The other half of "what can I use here".
 *
 * `speq docs` answers what the *plugins* offer, and that answer is identical in
 * every project that installed them. This answers the half that is different in
 * every project and written down nowhere: the blocks, actions and fixtures this
 * team has already built. It was the expensive half — a module action is a file
 * somebody wrote last quarter, and learning it took a `grep` or a colleague, so
 * a newcomer and a model both reached for `http` and rebuilt a login twice.
 */
describe('speq modules', () => {
  /** A command surface, provided the way `@speqkit/plugin-cli` provides it. */
  function cliStub(): { plugin: ReturnType<typeof definePlugin>; commands: Map<string, CommandDef> } {
    const commands = new Map<string, CommandDef>()
    return {
      commands,
      plugin: definePlugin({
        name: 'cli-stub',
        setup(ctx) {
          ctx.provide<CommandHost>('cli', { commands, register: (name, def) => commands.set(name, def) })
        }
      })
    }
  }

  async function modules(argv: string[] = []): Promise<{ code: number; output: string }> {
    const cli = cliStub()
    kit = await harness(use, { with: [api, cli.plugin], root })
    const command = cli.commands.get('modules')
    if (!command) throw new Error('plugin-use registered no `modules` command')

    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stdout.write
    try {
      return { code: await command.run(argv), output: written.join('') }
    } finally {
      process.stdout.write = original
    }
  }

  beforeEach(() => {
    write('modules/menu.yaml', `
actions:
  createCategory:
    properties: [accessToken, name]
    steps:
      - id: created
        type: call
        path: /categories
    returns:
      id: \${created.body.id}
  deleteCategory:
    properties: [accessToken, id]
    steps:
      - type: call
        path: /categories/delete
`)
    write('shared/register-tenant.yaml', `
steps:
  - id: tenant
    type: call
    path: /auth/register
`)
    write('fixtures/menu-item.yaml', `
fixture:
  build:
    name: an item
    price: 500
`)
  })

  it('names every action, and what it has to be called with', async () => {
    const { code, output } = await modules()

    expect(code).toBe(0)
    expect(output).toContain('menu.createCategory')
    expect(output).toContain('accessToken, name')
    expect(output).toContain('menu.deleteCategory')
  })

  it('hands back a `use` step for each, ready to paste', async () => {
    const { output } = await modules()

    expect(output).toContain('- type: use')
    expect(output).toContain('action: menu.createCategory')
    expect(output).toContain('ref: register-tenant')
    expect(output).toContain('fixture: menu-item')
  })

  it('says what a block hands back, which is the part a caller has to know', async () => {
    const { output } = await modules(['--json'])
    const library = JSON.parse(output) as {
      groups: { dir: string; entries: { call: string; takes: string[] }[] }[]
    }

    const shared = library.groups.find((g) => g.dir === 'shared')!
    // A block with no `returns` publishes its steps by id, and that is the
    // interface its caller is actually addressing.
    expect(shared.entries[0]!.takes).toEqual(['→ tenant'])

    const fixtures = library.groups.find((g) => g.dir === 'fixtures')!
    expect(fixtures.entries[0]!.takes).toEqual(['name', 'price'])
  })

  it('is not stopped by one file that does not parse', async () => {
    write('modules/broken.yaml', 'actions: [this is not a map\n')
    const { code, output } = await modules()

    // Which file is broken, and why, is `speq validate`'s answer. A catalogue
    // that refuses to print because one file is bad helps nobody.
    expect(code).toBe(0)
    expect(output).toContain('menu.createCategory')
  })

  it('says so plainly in a project that has built nothing yet', async () => {
    rmSync(join(root, 'modules'), { recursive: true, force: true })
    rmSync(join(root, 'shared'), { recursive: true, force: true })
    rmSync(join(root, 'fixtures'), { recursive: true, force: true })
    const { code, output } = await modules()

    expect(code).toBe(0)
    expect(output).toContain('Nothing declared yet')
  })
})
