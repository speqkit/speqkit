import type { Capabilities, Diagnostic, Host, SuiteDef, TestDef } from '@speqkit/plugin-api'

export interface ProjectDocument {
  /** The `.speq` directory this session was started in. */
  root: string
  /** The environment layer in effect, when `--env` or SPEQ_ENV asked for one. */
  env?: string
  /**
   * The whole grammar the loaded plugins define, with schemas.
   *
   * This is what makes the page answer "which plugin is responsible for this
   * line": a step's `type` is a word, and only the running session knows whose
   * word it is. Baking a table of step types into this plugin would give an
   * answer that is wrong the moment somebody installs one more plugin, and
   * wrong silently.
   */
  capabilities: Capabilities
  /** Every test the loaders found, cases expanded, exactly as a run would take them. */
  tests: TestDef[]
  /** Every declared suite any test is inside, deduplicated by name. */
  suites: SuiteDef[]
  /** What `speq validate` would say about all of it, right now. */
  diagnostics: Diagnostic[]
  /** Every distinct `source`, so the page can draw a file tree. */
  files: string[]
}

/**
 * The project, as one document.
 *
 * Assembled entirely through `ctx.host` — `discover`, `validate` and
 * `capabilities` — which is the point worth making twice: a panel needs
 * exactly the three verbs the CLI needs, so a surface that is not the terminal
 * costs nothing extra on the contract. The roadmap item this closes says "as a
 * plugin, the way `plugin-cli` is one", and the way to keep that honest is to
 * reach for nothing the terminal does not already reach for.
 *
 * Read fresh on every request rather than cached: somebody looking at this
 * page has their editor open beside it, and a project view that is stale is a
 * project view that is lying.
 */
export async function readProject(host: Host): Promise<ProjectDocument> {
  const tests = await host.discover()
  const suites = new Map<string, SuiteDef>()
  const files = new Set<string>()

  for (const test of tests) {
    if (test.source) files.add(test.source)
    for (const suite of test.suites ?? []) {
      if (!suites.has(suite.name)) suites.set(suite.name, suite)
    }
  }

  return {
    root: host.root,
    ...(host.env ? { env: host.env } : {}),
    capabilities: host.capabilities(),
    tests,
    suites: [...suites.values()].sort((a, b) => a.name.localeCompare(b.name)),
    // The diagnostics a run would refuse to start on, shown before anybody
    // starts one. A typo in a step type is the failure this catches, and it is
    // the one that otherwise looks exactly like a test that never ran.
    diagnostics: host.validate(tests),
    files: [...files].sort()
  }
}
