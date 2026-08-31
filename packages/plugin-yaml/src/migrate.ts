import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  Document, Pair, Scalar, YAMLMap, YAMLSeq,
  isMap, isScalar, isSeq, parseDocument, parse as parseYaml, visit
} from 'yaml'
import type { CommandHost, PluginContext } from '@speqkit/plugin-api'

/**
 * `speq migrate` — the v1 suite, rewritten.
 *
 * The codemod lives with the loader because it is the same knowledge pointed
 * backwards: the plugin that decides what `${...}` means is the only honest
 * place for the thing that turns `{{...}}` into it.
 *
 * Two rules shape everything below.
 *
 * **It writes nothing it cannot explain.** Where a v1 construct has no
 * successor — a suite-level `beforeEach`, a retry policy whose plugin has not
 * been written yet — it is reported, by file, with what to do instead. A
 * codemod that silently drops what it does not understand is worse than one
 * that refuses: the suite still runs, and the check that used to guard it is
 * simply gone.
 *
 * **It keeps the comments.** These files are documentation as much as tests —
 * the corpus this was written against explains its `.0.` index, its choice of
 * uuid over a word list, and why one action is one HTTP call. Rewriting
 * through the YAML document tree rather than parse-and-restringify is what
 * keeps all of that attached to the lines it is about.
 */

const EXIT_OK = 0
const EXIT_PROBLEM = 2

interface Note {
  file: string
  message: string
  hint?: string
}

interface Output {
  /** Relative to the output root. */
  path: string
  content: string
  state: 'new' | 'rewritten' | 'copied'
}

interface Plan {
  from: string
  out: string
  outputs: Output[]
  notes: Note[]
  unchanged: number
}

interface GeneratorSpec {
  type: string
  [key: string]: unknown
}

/** What one pass over the project needs to know before it can rewrite a line. */
interface Survey {
  manifest: Record<string, unknown>
  dirs: { suites: string; modules: string; fixtures: string; shared: string; schemas: string; environments: string }
  /** Names an environment defines, addressable as `${vars:name}` afterwards. */
  vars: Set<string>
  environments: string[]
  defaultEnvironment: string | undefined
  /** Shared block file (bare name) → the ids it publishes to its caller. */
  blocks: Map<string, string[]>
  /** The manifest's retry policy, in the words plugin-http uses. */
  retry: Record<string, unknown> | undefined
}

/**
 * v1 named the same policy differently and kept it at the top of the project,
 * where it applied to everything. It belongs to the plugin that does the
 * repeating, which is also the only thing that knows what a 429 means.
 */
function retryPolicy(raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw || raw.enabled === false) return undefined
  const on = (raw.retryOn ?? {}) as Record<string, unknown>
  const status = Array.isArray(on.statusCodes) ? (on.statusCodes as number[]).filter((c) => c !== 429) : undefined
  return {
    attempts: typeof raw.maxAttempts === 'number' ? raw.maxAttempts : 3,
    ...(typeof raw.delayMs === 'number' ? { delayMs: raw.delayMs } : {}),
    ...(raw.backoff === 'fixed' || raw.backoff === 'exponential' ? { backoff: raw.backoff } : {}),
    ...(typeof on.networkErrors === 'boolean' ? { network: on.networkErrors } : {}),
    ...(status ? { status } : {})
  }
}

export function registerMigrate(ctx: PluginContext): void {
  ctx.inject(['cli'], (services) => {
    const cli = services.cli as CommandHost
    cli.register('migrate', {
      summary: 'rewrite a speq 1.x suite into this format',
      usage: 'speq migrate [--from <dir>] [--out <dir>] [--write]',
      run(argv) {
        const from = resolveDir(flag(argv, '--from') ?? ctx.host.root)
        const out = resolveDir(flag(argv, '--out') ?? from)

        if (!existsSync(join(from, 'manifest.yaml'))) {
          process.stderr.write(
            `no manifest.yaml in ${from}, so there is no speq 1.x project to read.\n` +
              `Point at one with --from <dir>.\n`
          )
          return EXIT_PROBLEM
        }

        const plan = planMigration(from, out)
        report(plan, argv.includes('--write'))

        if (argv.includes('--write')) {
          for (const output of plan.outputs) {
            const path = join(out, output.path)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, output.content)
          }
        }
        return EXIT_OK
      }
    })
  })
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

export function planMigration(from: string, out: string): Plan {
  const notes: Note[] = []
  const survey = surveyProject(from, notes)
  const generators = new Map<string, GeneratorSpec>()
  const outputs: Output[] = []
  let unchanged = 0

  for (const dir of [survey.dirs.suites, survey.dirs.shared, survey.dirs.modules, survey.dirs.fixtures]) {
    for (const file of yamlFiles(join(from, dir))) {
      const path = relative(from, file)
      const before = readFileSync(file, 'utf8')
      const after = migrateFile(path, before, { survey, generators, notes })
      if (after === undefined) continue
      if (after === before) unchanged += 1
      else outputs.push({ path, content: after, state: 'rewritten' })
    }
  }

  // Config last: the generators a fixture needed are only known once every
  // fixture has been read.
  outputs.push(...migrateConfig(from, survey, generators, notes))

  // Schemas travel verbatim — they are JSON Schema, which did not change.
  if (resolve(out) !== resolve(from)) {
    for (const file of filesUnder(join(from, survey.dirs.schemas))) {
      outputs.push({ path: relative(from, file), content: readFileSync(file, 'utf8'), state: 'copied' })
    }
  }

  return { from, out, outputs, notes, unchanged }
}

function surveyProject(from: string, notes: Note[]): Survey {
  const manifest = (parseYaml(readFileSync(join(from, 'manifest.yaml'), 'utf8')) ?? {}) as Record<string, unknown>
  const dirs = {
    suites: str(manifest.suitesDir) ?? 'suites',
    modules: str(manifest.modulesDir) ?? 'modules',
    fixtures: str(manifest.fixturesDir) ?? 'fixtures',
    shared: str(manifest.sharedDir) ?? 'shared',
    schemas: str(manifest.schemasDir) ?? 'schemas',
    environments: str(manifest.environmentsDir) ?? 'environments'
  }

  // Every key an environment file sets that is not the connection itself is a
  // project value: `adminApi` and `tenantPassword` had nowhere else to live in
  // v1, and `{{adminApi}}` read exactly like a step reference. They become
  // `${vars:adminApi}`, which says where the value came from.
  const vars = new Set<string>()
  const environments: string[] = []
  for (const file of yamlFiles(join(from, dirs.environments))) {
    environments.push(basename(file, extname(file)))
    const value = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>
    for (const key of Object.keys(value)) {
      if (key !== 'name' && key !== 'baseUrl' && key !== 'headers') vars.add(key)
    }
  }

  const blocks = new Map<string, string[]>()
  for (const file of yamlFiles(join(from, dirs.shared))) {
    const value = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>
    const returns = value.returns as Record<string, unknown> | undefined
    const steps = (value.steps as { id?: string }[] | undefined) ?? []
    blocks.set(
      basename(file, extname(file)),
      returns ? Object.keys(returns) : steps.map((s) => s.id).filter((id): id is string => !!id)
    )
  }

  const coverage = manifest.coverage as Record<string, unknown> | undefined
  if (coverage && coverage.enabled !== false) {
    notes.push({
      file: 'manifest.yaml',
      message: "'coverage' has no home yet and was not carried over",
      hint: 'coverage against an OpenAPI document is plugin-openapi, which is not written'
    })
  }

  const retry = manifest.retry as Record<string, unknown> | undefined
  if (retry && retry.enabled !== false) {
    notes.push({
      file: 'speq.yaml',
      message: 'the retry policy moved under http, and now repeats only idempotent methods',
      hint: 'v1 repeated a POST through a 502, which creates the row twice when the origin ' +
        'saw the request and the gateway lost the answer. Name the method under ' +
        "http.retry.methods where an endpoint is known to be safe to repeat"
    })
  }

  return { manifest, dirs, vars, environments, defaultEnvironment: str(manifest.defaultEnvironment), blocks, retry: retryPolicy(retry) }
}

/* ------------------------------------------------------------------ */
/* One file                                                            */
/* ------------------------------------------------------------------ */

interface Rewrite {
  survey: Survey
  generators: Map<string, GeneratorSpec>
  notes: Note[]
}

/** `undefined` when the file is deliberately not carried over. */
function migrateFile(path: string, content: string, rw: Rewrite): string | undefined {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) {
    rw.notes.push({ file: path, message: `left alone: ${doc.errors[0]!.message}` })
    return undefined
  }
  const root = doc.contents
  if (!isMap(root)) return undefined

  if (basename(path, extname(path)) === 'init') return migrateInit(path, doc, root, rw)

  // Which `use` step each shared-block binding now belongs to. A v1 block
  // published its step ids straight into the calling test — `{{tenant.…}}`
  // with nothing saying where `tenant` came from. Here a block runs in its
  // own scope and hands its result back through the step that called it, so
  // every one of those references gains an owner. That is the one semantic
  // change in this migration, and it is the point of it: what used to be a
  // leak is now written down at the call site.
  const owners = assignBlockOwners(root, rw)

  rewriteScalars(doc, owners, rw)
  rewriteStructure(path, root, rw)

  const rewritten = doc.toString({ lineWidth: 0 })
  if (rewritten.includes('{{')) {
    rw.notes.push({
      file: path,
      message: 'a comment here still describes the v1 spelling',
      hint: 'prose is left alone on purpose — a comment explaining what callers write is ' +
        'not something a codemod can rewrite correctly, because the answer differs per caller'
    })
  }
  return rewritten
}

/**
 * `init.yaml` describes its directory. In v1 it also carried suite hooks and
 * module aliases, and neither survives: hooks have no successor yet, and
 * aliases are unnecessary because an action is named `module.action` outright.
 */
function migrateInit(path: string, doc: Document, root: YAMLMap, rw: Rewrite): string | undefined {
  const suite = root.get('suite')
  if (isMap(suite)) {
    for (const hook of ['beforeEach', 'afterEach'] as const) {
      if (suite.get(hook) === undefined) continue
      rw.notes.push({
        file: path,
        message: `suite.${hook} was not carried over — there is no suite-level hook yet`,
        hint: 'the steps are still in the v1 file; move them into each test\'s setup/cleanup, ' +
          'or wait for the hook surface a reporter-style plugin will need anyway'
      })
    }
    if (suite.get('imports') !== undefined) {
      rw.notes.push({
        file: path,
        message: 'suite.imports was dropped, and nothing is lost',
        hint: "a use step names its action in full — action: menu.createCategory — so there is no alias to declare"
      })
    }
    root.delete('suite')
  }

  const remaining = root.items.length
  if (remaining === 0) {
    rw.notes.push({ file: path, message: 'nothing left to write; the file is not carried over' })
    return undefined
  }
  return doc.toString({ lineWidth: 0 })
}

/**
 * A `use` step written by file gets an id, and every binding its block
 * publishes is recorded against it.
 */
function assignBlockOwners(root: YAMLMap, rw: Rewrite): Map<string, string> {
  const owners = new Map<string, string>()
  const taken = new Set<string>()

  for (const phase of ['setup', 'steps', 'cleanup'] as const) {
    const seq = root.get(phase)
    if (!isSeq(seq)) continue
    for (const step of seq.items) {
      if (!isMap(step)) continue
      const ref = step.get('ref')
      if (typeof ref !== 'string') continue

      const block = basename(String(ref), extname(String(ref)))
      const existing = str(step.get('id')) ?? str(step.get('as'))
      const id = existing ?? unique(camel(block), taken)
      taken.add(id)

      // Stamped here rather than in the structural pass, because this is where
      // the name is decided: the references being rewritten and the step they
      // now point at have to agree, and one function knowing both is the only
      // way they can.
      if (!existing) step.items.unshift(new Pair(new Scalar('id'), new Scalar(id)) as never)

      for (const published of rw.survey.blocks.get(block) ?? []) owners.set(published, id)
    }
  }
  return owners
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const V1_TEMPLATE = /\{\{([^}]+)\}\}/g
const V1_STEP_PATH = /^\$steps\.(.+)$/

function rewriteScalars(doc: Document, owners: Map<string, string>, rw: Rewrite): void {
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== 'string') return
      const before = node.value
      let after = before.replace(V1_TEMPLATE, (_m, expr: string) => `\${${reference(expr.trim(), owners, rw.survey)}}`)

      // `returns:` in a module wrote a path with no braces at all.
      const stepPath = V1_STEP_PATH.exec(after)
      if (stepPath?.[1]) after = `\${${reference(stepPath[1], owners, rw.survey)}}`

      if (after === before) return
      node.value = after
      if (after.includes('${')) node.type = Scalar.QUOTE_DOUBLE
    }
  })
}

/**
 * One v1 reference, in this format's spelling.
 *
 *   {{adminApi}}                        ->  ${vars:adminApi}
 *   {{tenant.response.body.token}}      ->  ${registerTenant.tenant.body.token}
 *   {{r.response.body.0.id}}            ->  ${r.body[0].id}
 *   {{fresh.response.headers.etag}}     ->  ${fresh.headers.etag}
 *
 * `.response.` disappears because a step result is no longer an envelope
 * around an HTTP response — a step returns what it produced, and `body` is
 * one of the things an HTTP step produces.
 */
function reference(expr: string, owners: Map<string, string>, survey: Survey): string {
  const segments = expr.split('.').map((s) => s.trim()).filter(Boolean)
  const head = segments[0]
  if (!head) return expr

  const tail = segments.slice(1)
  if (tail[0] === 'response') tail.shift()

  if (survey.vars.has(head) && tail.length === 0) return `vars:${head}`

  const owner = owners.get(head)
  const path = [...(owner ? [owner] : []), head]
  let out = path.join('.')
  for (const segment of tail) {
    out += /^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

const PARKED = 'carried over from speq 1.x — replace this with the reason'

function rewriteStructure(file: string, root: YAMLMap, rw: Rewrite): void {
  const where = { file, rw }

  // `status: pending` becomes `pending: <why>`. v1 had nowhere to put the
  // reason, so it is always in a comment above — which is why the codemod
  // writes a placeholder rather than inventing one, and says so.
  const status = findPair(root, 'status')
  if (status && isScalar(status.value) && status.value.value === 'pending') {
    ;(status.key as Scalar).value = 'pending'
    status.value.value = PARKED
    status.value.type = Scalar.QUOTE_DOUBLE
    rw.notes.push({
      file,
      message: 'this test is pending and now has to say why',
      hint: 'the reason is in the comment beside it; move it into the `pending:` line, ' +
        'where a reader of the report will see it'
    })
  }

  const variables = root.get('variables')
  if (isMap(variables)) rewriteGenerators(variables, nameFrom(file), where)

  for (const phase of ['setup', 'steps', 'cleanup'] as const) {
    const seq = root.get(phase)
    if (isSeq(seq)) rewriteSteps(seq, where)
  }

  // A module: every action has its own steps.
  const actions = root.get('actions')
  if (isMap(actions)) {
    for (const pair of actions.items) {
      if (!isMap(pair.value)) continue
      const steps = pair.value.get('steps')
      if (isSeq(steps)) rewriteSteps(steps, where)
    }
  }

  // A fixture: its `build` block is the only place values are generated.
  const fixture = root.get('fixture')
  if (isMap(fixture)) {
    const build = fixture.get('build')
    if (isMap(build)) rewriteGenerators(build, nameFrom(file), where)
  }
}

interface Where {
  file: string
  rw: Rewrite
}

function rewriteSteps(seq: YAMLSeq, where: Where): void {
  const items: unknown[] = []
  const taken = new Set<string>()
  for (const item of seq.items) {
    if (isMap(item)) {
      const id = str(item.get('id')) ?? str(item.get('as'))
      if (id) taken.add(id)
    }
  }

  for (const item of seq.items) {
    if (!isMap(item)) {
      items.push(item)
      continue
    }
    const prelude = liftFixture(item, taken)
    if (prelude) items.push(prelude)
    rewriteStep(item, where)
    items.push(item)
  }
  seq.items = items as YAMLSeq['items']
}

function rewriteStep(step: YAMLMap, where: Where): void {
  const type = step.get('type')
  if (type === 'api') set(step, 'type', 'http')

  // A step's display name is an annotation, and on a step annotations have to
  // say so: every other unknown key belongs to the plugin that owns `type`,
  // and `plugin-http` closes its schema. `meta:` is the reserved word that
  // keeps `name:` from being handed to a plugin that would reject it.
  const name = findPair(step, 'name')
  if (name) {
    const inner = new YAMLMap()
    inner.add(new Pair(new Scalar('name'), name.value))
    ;(name.key as Scalar).value = 'meta'
    name.value = inner
  }

  const as = findPair(step, 'as')
  if (as) (as.key as Scalar).value = 'id'

  const ref = step.get('ref')
  if (typeof ref === 'string') {
    // Root-relative or bare, never `../../../` — a block is resolved by the
    // plugin, which is not told which file asked for it.
    set(step, 'ref', basename(ref, extname(ref)))
  }

  const assertions = step.get('assert')
  if (isSeq(assertions)) rewriteAssertions(assertions)

  const nested = step.get('steps')
  if (isSeq(nested)) rewriteSteps(nested, where)
}

/**
 * `bodyFromFixture` becomes what it always was: a call, and then a body.
 *
 * v1 folded "build this from a fixture" into the HTTP step, which meant the
 * one construct that produces data was spelled differently from every other
 * construct that produces data. Split in two, it is a `use` step like any
 * other — and the built body is addressable, so a test can assert on what it
 * sent.
 */
function liftFixture(step: YAMLMap, taken: Set<string>): YAMLMap | undefined {
  const pair = findPair(step, 'bodyFromFixture')
  if (!pair || !isMap(pair.value)) return undefined

  const spec = pair.value
  const ref = String(spec.get('ref') ?? '')
  const fixture = basename(ref, extname(ref))
  const id = unique(`${camel(fixture)}Body`, taken)
  taken.add(id)

  const built = new YAMLMap()
  built.add(new Pair(new Scalar('id'), new Scalar(id)))
  built.add(new Pair(new Scalar('type'), new Scalar('use')))
  built.add(new Pair(new Scalar('fixture'), new Scalar(fixture)))
  const overrides = findPair(spec, 'overrides')
  if (overrides) built.add(overrides)
  // The comment moves with the thing it was about — it explained the fixture,
  // and the fixture is now a step of its own.
  built.commentBefore = spec.commentBefore ?? (isScalar(pair.key) ? pair.key.commentBefore : null) ?? null
  spec.commentBefore = null
  if (isScalar(pair.key)) pair.key.commentBefore = null

  ;(pair.key as Scalar).value = 'body'
  const body = new Scalar(`\${${id}}`)
  body.type = Scalar.QUOTE_DOUBLE
  pair.value = body

  return built
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

/**
 * The v1 vocabulary, in the words `plugin-assert` uses.
 *
 * Two kinds of change. Some are renames — `notcontains` is `not_contains`
 * because every other word here is written the same way. The rest are the
 * selector: v1 assertions each knew privately what they were looking at, and
 * a shared vocabulary cannot, so what used to be implicit is now written.
 * `$.name` becomes `body.name`, and a `contains` that meant "somewhere in the
 * response text" says `path: text`.
 */
function rewriteAssertions(seq: YAMLSeq): void {
  for (const item of seq.items) {
    if (!isMap(item)) continue
    const type = String(item.get('type') ?? '')

    switch (type) {
      case 'json':
        set(item, 'type', 'equals')
        break
      case 'notcontains':
        set(item, 'type', 'not_contains')
        break
      case 'regex':
        set(item, 'type', 'matches')
        break
    }

    const path = item.get('path')
    if (typeof path === 'string') {
      set(item, 'path', selector(path))
    } else if (type === 'contains' || type === 'notcontains') {
      // It read the whole response as one string, which is `text` now.
      insertAfter(item, 'type', 'path', 'text')
    } else if (type === 'schema') {
      // v1 validated the parsed body; `path` says so rather than assuming it.
      insertAfter(item, 'type', 'path', 'body')
    }
  }
}

/** `$.a.b` addressed the parsed body; a path now starts at the whole result. */
function selector(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '$') return 'body'
  const inner = trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed
  return inner.startsWith('body') ? inner : `body.${inner}`
}

/* ------------------------------------------------------------------ */
/* Generated values                                                    */
/* ------------------------------------------------------------------ */

/**
 * `{ gen: { type: uuid } }` becomes `"${gen:uuid}"`.
 *
 * A generator with parameters cannot be written inline, and that is on
 * purpose: `${...}` names something, it does not configure it. So a
 * parameterised generator is declared once under `data.generators` and named
 * from then on — which also means the two fixtures that want a 16-to-64
 * character description share one answer to how long that is.
 */
function rewriteGenerators(map: YAMLMap, origin: string, where: Where): void {
  for (const pair of map.items) {
    if (!isMap(pair.value)) continue
    const spec = pair.value.get('gen')
    if (!isMap(spec)) continue

    const type = String(spec.get('type') ?? '')
    const parameters: GeneratorSpec = { type }
    for (const item of spec.items) {
      const key = String((item.key as Scalar).value)
      if (key !== 'type') parameters[key] = (item.value as Scalar).value
    }

    const field = String((pair.key as Scalar).value)
    const name = Object.keys(parameters).length === 1
      ? type
      : declare(`${origin}${capitalise(camel(field))}`, parameters, where)

    const scalar = new Scalar(`\${gen:${name}}`)
    scalar.type = Scalar.QUOTE_DOUBLE
    scalar.comment = (pair.value as YAMLMap).comment ?? null
    pair.value = scalar
  }
}

/** Records a parameterised generator, keeping two different ones apart. */
function declare(preferred: string, spec: GeneratorSpec, where: Where): string {
  const { generators, notes } = where.rw
  const existing = generators.get(preferred)
  if (!existing) {
    generators.set(preferred, spec)
    return preferred
  }
  if (JSON.stringify(existing) === JSON.stringify(spec)) return preferred

  let n = 2
  while (generators.has(`${preferred}${n}`)) n += 1
  const name = `${preferred}${n}`
  generators.set(name, spec)
  notes.push({
    file: 'speq.yaml',
    message: `two generators wanted the name '${preferred}' with different parameters; the second is '${name}'`,
    hint: 'rename it to something the tests reading it will recognise'
  })
  return name
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const PLUGINS = ['yaml', 'cli', 'http', 'assert', 'data', 'use']

function migrateConfig(
  from: string,
  survey: Survey,
  generators: Map<string, GeneratorSpec>,
  notes: Note[]
): Output[] {
  const outputs: Output[] = []
  const environments = new Map<string, Record<string, unknown>>()

  for (const file of yamlFiles(join(from, survey.dirs.environments))) {
    const name = basename(file, extname(file))
    const doc = parseDocument(readFileSync(file, 'utf8'))
    const root = doc.contents
    if (!isMap(root)) continue

    environments.set(name, (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>)
    outputs.push({
      path: relative(from, file),
      content: migrateEnvironment(doc, root),
      state: 'rewritten'
    })
  }

  const fallback = survey.defaultEnvironment && environments.get(survey.defaultEnvironment)
  if (survey.defaultEnvironment && !fallback) {
    notes.push({
      file: 'manifest.yaml',
      message: `defaultEnvironment names '${survey.defaultEnvironment}', which has no file`
    })
  }

  outputs.push({
    path: 'speq.yaml',
    content: writeConfig(survey, fallback || {}, generators),
    state: 'new'
  })
  notes.push({
    file: 'manifest.yaml',
    message: 'replaced by speq.yaml; nothing reads manifest.yaml any more',
    hint: 'delete it once the migrated suite runs'
  })
  return outputs
}

/**
 * An environment file keeps its comments and changes shape: the connection
 * belongs to the HTTP plugin, everything else is a project value.
 */
function migrateEnvironment(doc: Document, root: YAMLMap): string {
  const http = new YAMLMap()
  const vars = new YAMLMap()

  for (const pair of root.items) {
    const key = String((pair.key as Scalar).value)
    if (key === 'name') continue
    const target = key === 'baseUrl' || key === 'headers' ? http : vars
    // The blank line that set this key apart from the one above it is not a
    // separator any more when it has become the first line of its own block.
    if (target.items.length === 0 && isScalar(pair.key)) pair.key.spaceBefore = false
    target.add(pair)
  }

  const out = new YAMLMap()
  if (http.items.length > 0) out.add(new Pair(new Scalar('http'), http))
  if (vars.items.length > 0) {
    const data = new YAMLMap()
    data.add(new Pair(new Scalar('vars'), vars))
    out.add(new Pair(new Scalar('data'), data))
  }

  const written = new Document(out)
  written.commentBefore = doc.commentBefore ?? null
  return written.toString({ lineWidth: 0 })
}

/**
 * Written by hand rather than serialised, because the reader of this file is
 * a person deciding whether the migration was right.
 */
function writeConfig(
  survey: Survey,
  fallback: Record<string, unknown>,
  generators: Map<string, GeneratorSpec>
): string {
  const project = str(survey.manifest.project) ?? 'this project'
  const chosen = survey.defaultEnvironment
  const lines: string[] = [
    `# ${project} — written by 'speq migrate' from manifest.yaml.`,
    '#',
    '# The plugin set is what speq.lock pins, so it lives here and nowhere',
    '# else: an environment tunes settings and may not add a plugin.',
    'version: 1',
    '',
    'plugins:',
    ...PLUGINS.map((p) => `  - ${p}`),
    ''
  ]

  if (chosen) {
    lines.push(
      `# There is no 'defaultEnvironment' any more: an environment is a layer you`,
      `# ask for. What '${chosen}' set is inlined here so a bare 'speq run' behaves`,
      `# as it did, and 'speq run --env ${chosen}' applies the same values again.`
    )
  }

  const baseUrl = str(fallback.baseUrl)
  const headers = fallback.headers as Record<string, unknown> | undefined
  lines.push('http:')
  lines.push(`  baseUrl: ${quote(baseUrl ?? 'http://localhost:8080')}`)
  if (headers && Object.keys(headers).length > 0) {
    lines.push('  headers:')
    for (const [key, value] of Object.entries(headers)) lines.push(`    ${key}: ${quote(String(value))}`)
  }
  if (survey.retry) {
    lines.push('  # Absorbs the gap between "the container is up" and "the API answers".')
    lines.push('  # 429 is deliberately not in the list: a rate limiter is behaviour a suite')
    lines.push('  # tests, and a policy that retries through one makes that test pass whether')
    lines.push('  # the limiter exists or not.')
    lines.push('  retry:')
    for (const [key, value] of Object.entries(survey.retry)) {
      lines.push(`    ${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : String(value)}`)
    }
  }
  lines.push('')

  lines.push('use:')
  lines.push(`  modulesDir: ${survey.dirs.modules}`)
  lines.push(`  sharedDir: ${survey.dirs.shared}`)
  lines.push(`  fixturesDir: ${survey.dirs.fixtures}`)
  lines.push('')
  lines.push('assert:')
  lines.push(`  schemasDir: ${survey.dirs.schemas}`)
  lines.push('')

  const vars = [...survey.vars].filter((name) => fallback[name] !== undefined)
  if (vars.length > 0 || generators.size > 0) {
    lines.push('data:')
    if (vars.length > 0) {
      lines.push('  # Project values, addressable as ${vars:name} and tuned per environment.')
      lines.push('  vars:')
      for (const name of vars) lines.push(`    ${name}: ${quote(String(fallback[name]))}`)
    }
    if (generators.size > 0) {
      lines.push('  # Generators with parameters, named once and used by name.')
      lines.push('  generators:')
      for (const [name, spec] of [...generators].sort(([a], [b]) => a.localeCompare(b))) {
        const body = Object.entries(spec).map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v) : String(v)}`)
        lines.push(`    ${name}: { ${body.join(', ')} }`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

const E = '\x1b['
const dim = (s: string) => `${E}2m${s}${E}0m`
const yellow = (s: string) => `${E}33m${s}${E}0m`

function report(plan: Plan, wrote: boolean): void {
  const out = process.stdout
  out.write(`\nreads   ${plan.from}\n`)
  out.write(
    wrote
      ? `writes  ${plan.out}\n\n`
      : `writes  ${plan.out} ${yellow('— nothing was written; add --write')}\n\n`
  )

  const byState = (state: Output['state']) => plan.outputs.filter((o) => o.state === state).length
  out.write(
    `${byState('rewritten')} rewritten, ${byState('new')} new, ` +
      `${byState('copied')} copied, ${plan.unchanged} already fine\n`
  )
  for (const output of plan.outputs) {
    out.write(`  ${output.path}${dim(`  ${output.state}`)}\n`)
  }

  if (plan.notes.length === 0) {
    out.write(`\nnothing was left behind.\n`)
    return
  }

  out.write(`\n${plan.notes.length} thing(s) this codemod will not decide for you\n`)
  let last = ''
  for (const note of plan.notes) {
    if (note.file !== last) out.write(`\n  ${note.file}\n`)
    last = note.file
    out.write(`    ${yellow(note.message)}\n`)
    if (note.hint) out.write(`    ${dim(note.hint)}\n`)
  }
  out.write('\n')
}

/* ------------------------------------------------------------------ */
/* Small things                                                        */
/* ------------------------------------------------------------------ */

function findPair(map: YAMLMap, key: string): Pair<unknown, unknown> | undefined {
  return map.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<unknown, unknown> | undefined
}

/** Replace a value in place, so the key keeps its position and its comment. */
function set(map: YAMLMap, key: string, value: string): void {
  const pair = findPair(map, key)
  if (!pair) return
  if (isScalar(pair.value)) pair.value.value = value
  else pair.value = new Scalar(value)
}

function insertAfter(map: YAMLMap, after: string, key: string, value: string): void {
  const index = map.items.findIndex((p) => isScalar(p.key) && p.key.value === after)
  map.items.splice(index + 1, 0, new Pair(new Scalar(key), new Scalar(value)) as never)
}

function yamlFiles(dir: string): string[] {
  return filesUnder(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
}

function filesUnder(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries.sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

function nameFrom(file: string): string {
  return camel(basename(file, extname(file)))
}

function camel(value: string): string {
  const parts = value.split(/[-_. ]+/).filter(Boolean)
  return parts.map((p, i) => (i === 0 ? lower(p) : capitalise(p))).join('')
}

function lower(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1)
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function unique(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred
  let n = 2
  while (taken.has(`${preferred}${n}`)) n += 1
  return `${preferred}${n}`
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resolveDir(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
