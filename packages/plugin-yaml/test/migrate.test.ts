import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Registry, createHost, discoverTests, loadConfig, validateTests } from 'speqkit'
import yaml from '@speqkit/plugin-yaml'
import http from '@speqkit/plugin-http'
import assertions from '@speqkit/plugin-assert'
import data from '@speqkit/plugin-data'
import use from '@speqkit/plugin-use'
import { harness } from '@speqkit/test-kit'
import cli from '@speqkit/plugin-cli'
import type { CommandHost } from '@speqkit/plugin-api'
import { planMigration } from '../src/migrate.js'

/**
 * A v1 project small enough to read and wide enough to be the whole grammar:
 * both use forms, a fixture folded into a step, a module with `returns`, a
 * suite hook that has no successor, every assertion the old vocabulary had.
 *
 * The last test is the one that matters. Checking that a line came out looking
 * right proves the codemod agrees with itself; running the result through the
 * real loader, the real grammar and the real plugins is the only thing that
 * proves it produced a project.
 */

let from: string
let out: string

beforeEach(() => {
  from = mkdtempSync(join(tmpdir(), 'speq-v1-'))
  out = mkdtempSync(join(tmpdir(), 'speq-v2-'))
  for (const [path, content] of Object.entries(V1)) write(from, path, content)
})

afterEach(() => {
  rmSync(from, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
})

function write(root: string, path: string, content: string): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function migrate(): { file(path: string): string; notes: { file: string; message: string }[] } {
  const plan = planMigration(from, out)
  for (const output of plan.outputs) write(out, output.path, output.content)
  return {
    file: (path: string) => readFileSync(join(out, path), 'utf8'),
    notes: plan.notes
  }
}

const V1: Record<string, string> = {
  'manifest.yaml': [
    'version: "1"',
    'project: "shop"',
    'defaultEnvironment: "local"',
    'suitesDir: "suites"',
    'retry:',
    '  enabled: true',
    '  maxAttempts: 3'
  ].join('\n'),

  'environments/local.yaml': [
    'name: local',
    'baseUrl: http://localhost:8080',
    '',
    '# Route prefix, written into every url.',
    'adminApi: "/api/admin/v1"',
    'tenantPassword: "hunter2"',
    'headers:',
    '  x-speq-run: "shop"'
  ].join('\n'),

  'suites/init.yaml': [
    'suite:',
    '  beforeEach:',
    '    - type: api',
    '      name: "guard: the API is up"',
    '      method: GET',
    '      url: "{{adminApi}}/health"'
  ].join('\n'),

  'suites/menu/init.yaml': [
    '# The menu group.',
    'epic: menu',
    'suite:',
    '  imports:',
    '    - module: menu',
    '      alias: menu'
  ].join('\n'),

  'suites/menu/creates-item.yaml': [
    'id: "menu.creates-item"',
    'title: "POST /items creates an item"',
    'tags: [smoke]',
    'variables:',
    '  tenantSlug: { gen: { type: uuid } }',
    'setup:',
    '  - type: use',
    '    name: "setup: register a tenant"',
    '    ref: "../../shared/register-tenant.yaml"',
    '  - type: use',
    '    name: "setup: a parent category"',
    '    action: "menu.createCategory"',
    '    properties:',
    '      accessToken: "{{tenant.response.body.access_token}}"',
    '      restaurantId: "{{restaurants.response.body.0.id}}"',
    '    as: parentCategory',
    'steps:',
    '  - type: api',
    '    id: created',
    '    name: "POST {{adminApi}}/items"',
    '    method: POST',
    '    url: "{{adminApi}}/categories/{{parentCategory.id}}/items"',
    '    headers:',
    '      Authorization: "Bearer {{tenant.response.body.access_token}}"',
    '    # The name is pinned, the rest is generated.',
    '    bodyFromFixture:',
    '      ref: "menu-item.yaml"',
    '      overrides:',
    '        name: "speq-item"',
    '    assert:',
    '      - type: status',
    '        expected: 201',
    '      - type: json',
    '        path: "$.name"',
    '        expected: "speq-item"',
    '      - type: exists',
    '        path: "$.description"',
    '      - type: schema',
    '        ref: "item.schema.json"'
  ].join('\n'),

  'suites/menu/reads-menu.yaml': [
    'id: "menu.reads-menu"',
    'steps:',
    '  - type: api',
    '    id: fresh',
    '    method: GET',
    '    url: "{{adminApi}}/menu"',
    '    assert:',
    '      - type: contains',
    '        expected: "starters"',
    '      - type: notcontains',
    '        expected: "password"',
    '      - type: regex',
    '        path: "$.slug"',
    '        expected: "^[a-z-]+$"',
    '  - type: api',
    '    method: GET',
    '    url: "{{adminApi}}/menu"',
    '    headers:',
    '      If-None-Match: "{{fresh.response.headers.etag}}"',
    '    assert:',
    '      - type: status',
    '        expected: 304'
  ].join('\n'),

  'shared/register-tenant.yaml': [
    'steps:',
    '  - type: api',
    '    id: tenant',
    '    method: POST',
    '    url: "{{adminApi}}/auth/register"',
    '    body:',
    '      slug: "{{tenantSlug}}"',
    '      password: "{{tenantPassword}}"',
    '  - type: api',
    '    id: restaurants',
    '    method: GET',
    '    url: "{{adminApi}}/restaurants"',
    '    headers:',
    '      Authorization: "Bearer {{tenant.response.body.access_token}}"'
  ].join('\n'),

  'modules/menu.yaml': [
    'actions:',
    '  createCategory:',
    '    properties: [accessToken, restaurantId]',
    '    steps:',
    '      - type: api',
    '        id: created_category',
    '        name: "POST /categories"',
    '        method: POST',
    '        url: "{{adminApi}}/restaurants/{{restaurantId}}/categories"',
    '        headers:',
    '          Authorization: "Bearer {{accessToken}}"',
    '    returns:',
    '      id: "$steps.created_category.response.body.id"'
  ].join('\n'),

  'fixtures/menu-item.yaml': [
    'fixture:',
    '  build:',
    '    name: { gen: { type: string, minLength: 8, maxLength: 24 } }',
    '    slug: { gen: { type: uuid } }'
  ].join('\n'),

  'schemas/item.schema.json': JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } }
  })
}

describe('references', () => {
  it('spells one substitution syntax', () => {
    const item = migrate().file('suites/menu/creates-item.yaml')
    expect(item).not.toContain('{{')
    expect(item).toContain('${vars:adminApi}/categories/${parentCategory.id}/items')
  })

  it('drops the response envelope and indexes an array as one', () => {
    // `.response.` said that a step result was a wrapper around an HTTP
    // response. A step result is what the step produced, and `body` is one of
    // the things an HTTP step produces.
    expect(migrate().file('suites/menu/creates-item.yaml'))
      .toContain('${registerTenant.restaurants.body[0].id}')
  })

  it('sends a project value to where project values now live', () => {
    // `{{adminApi}}` read exactly like a step reference and was not one.
    expect(migrate().file('suites/menu/reads-menu.yaml')).toContain('${vars:adminApi}/menu')
  })

  it('gives a shared block an owner at every call site', () => {
    // The one semantic change in the migration, and its point: a v1 block
    // published its step ids straight into the caller, with nothing saying
    // where `tenant` came from. Now the step that called it is named.
    const item = migrate().file('suites/menu/creates-item.yaml')
    expect(item).toContain('id: registerTenant')
    expect(item).toContain('${registerTenant.tenant.body.access_token}')
  })

  it('rewrites a module return, which had no braces at all', () => {
    expect(migrate().file('modules/menu.yaml')).toContain('id: "${created_category.body.id}"')
  })
})

describe('steps', () => {
  it('renames the protocol step to the protocol', () => {
    expect(migrate().file('suites/menu/reads-menu.yaml')).toContain('type: http')
  })

  it("files a step's display name as an annotation", () => {
    // Every other unknown key on a step belongs to the plugin owning `type`,
    // and plugin-http closes its schema — so a name has to say it is not input.
    expect(migrate().file('suites/menu/creates-item.yaml')).toContain('    meta:\n      name: "POST ${vars:adminApi}/items"')
  })

  it('names a result the way every other step does', () => {
    const item = migrate().file('suites/menu/creates-item.yaml')
    expect(item).toContain('id: parentCategory')
    expect(item).not.toContain('as: parentCategory')
  })

  it('resolves a block by name rather than by how deep the caller sits', () => {
    expect(migrate().file('suites/menu/creates-item.yaml')).toContain('ref: "register-tenant"')
  })

  it('splits a folded fixture into the call it always was', () => {
    const item = migrate().file('suites/menu/creates-item.yaml')
    expect(item).toContain('- id: menuItemBody\n    type: use\n    fixture: menu-item')
    expect(item).toContain('body: "${menuItemBody}"')
    // And the comment went with the thing it was about, once.
    expect(item.match(/The name is pinned/g)).toHaveLength(1)
  })
})

describe('assertions', () => {
  it('uses the words the vocabulary uses', () => {
    const menu = migrate().file('suites/menu/reads-menu.yaml')
    expect(menu).toContain('type: not_contains')
    expect(menu).toContain('type: matches')
    expect(migrate().file('suites/menu/creates-item.yaml')).toContain('type: equals')
  })

  it('writes down what each one was privately looking at', () => {
    // A shared vocabulary cannot know it is looking at a response, so what
    // used to be implicit becomes a selector.
    const menu = migrate().file('suites/menu/reads-menu.yaml')
    expect(menu).toContain('type: contains\n        path: text')
    expect(menu).toContain('path: "body.slug"')

    const item = migrate().file('suites/menu/creates-item.yaml')
    expect(item).toContain('path: "body.name"')
    expect(item).toContain('type: schema\n        path: body')
  })
})

describe('generated values', () => {
  it('names a generator without parameters inline', () => {
    expect(migrate().file('suites/menu/creates-item.yaml')).toContain('tenantSlug: "${gen:uuid}"')
  })

  it('declares a parameterised one once and refers to it by name', () => {
    // `${...}` names something; it does not configure it. So the parameters
    // move to the config, where two fixtures wanting the same shape share one
    // answer to what that shape is.
    const migrated = migrate()
    expect(migrated.file('fixtures/menu-item.yaml')).toContain('name: "${gen:menuItemName}"')
    expect(migrated.file('speq.yaml'))
      .toContain('menuItemName: { type: "string", minLength: 8, maxLength: 24 }')
  })
})

describe('the project', () => {
  it('splits an environment into a connection and project values', () => {
    const local = migrate().file('environments/local.yaml')
    expect(local).toContain('http:\n  baseUrl: http://localhost:8080')
    expect(local).toContain('data:\n  vars:')
    expect(local).toContain('adminApi: "/api/admin/v1"')
    // The prose that explained the value came with it.
    expect(local).toContain('# Route prefix, written into every url.')
  })

  it('writes a speq.yaml that behaves the way defaultEnvironment did', () => {
    const config = migrate().file('speq.yaml')
    expect(config).toContain('baseUrl: "http://localhost:8080"')
    expect(config).toContain('tenantPassword: "hunter2"')
  })
})

describe('what it refuses to decide', () => {
  it('says a suite hook was not carried over, rather than dropping it', () => {
    // A codemod that silently drops what it does not understand is worse than
    // one that refuses: the suite still runs, and the guard is simply gone.
    const notes = migrate().notes
    expect(notes.some((n) => n.file === 'suites/init.yaml' && /beforeEach/.test(n.message))).toBe(true)
  })

  it('says the retry policy has no home yet', () => {
    expect(migrate().notes.some((n) => /retry/.test(n.message))).toBe(true)
  })

  it('keeps a directory annotation while dropping the aliases beside it', () => {
    const migrated = migrate()
    expect(migrated.file('suites/menu/init.yaml')).toContain('epic: menu')
    expect(migrated.file('suites/menu/init.yaml')).not.toContain('imports')
    expect(migrated.notes.some((n) => /imports/.test(n.message))).toBe(true)
  })
})

describe('where the command lives', () => {
  it('is contributed into the CLI, and the plugin works without one', async () => {
    // The codemod belongs to the plugin that owns the format — the thing that
    // decides what `${...}` means is the only honest place for the thing that
    // rewrites `{{...}}` into it. It reaches the terminal the way any plugin's
    // command does, and its absence costs the loader nothing.
    const withCli = await harness(yaml, { with: [cli] })
    const service = withCli.registry.service('cli') as CommandHost
    expect(service.commands.has('migrate')).toBe(true)
    await withCli.close()

    const alone = await harness(yaml)
    expect(alone.registry.service('cli')).toBeUndefined()
    await alone.close()
  })
})

describe('the result is a project', () => {
  it('loads and validates against the real grammar', async () => {
    migrate()

    const registry = new Registry()
    registry.setConfig(loadConfig(out).settings)
    registry.setHost(createHost(registry, { root: out }))
    for (const plugin of [yaml, http, assertions, data, use]) await registry.register(plugin)
    registry.settle()

    const tests = await discoverTests(registry, { root: out })
    expect(tests.map((t) => t.name)).toEqual(['menu.creates-item', 'menu.reads-menu'])
    // The directory annotation survived the round trip into the new loader.
    expect(tests[0]!.meta).toEqual({ epic: 'menu' })

    // Every step type, every assertion, every schema file on disk, every
    // action's declared properties — checked by the kernel, not by us.
    expect(validateTests(registry, tests)).toEqual([])
  })
})
