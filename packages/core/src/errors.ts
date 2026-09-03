/**
 * Why speq never got as far as running anything.
 *
 * `bootstrap()` is four steps — find the project, read the config, load the
 * plugins, hand over control — and each of the first three can refuse. Every
 * refusal used to be a bare `Error`, which meant the only way to tell "there
 * is no speq.yaml here" from "this speq.yaml is from a later build" from
 * "that plugin is declared but not installed" was to match substrings of a
 * sentence written for a person. M8 removed exactly that obligation from
 * validation, by putting a `code` on every `Diagnostic`; this is the same
 * removal one layer earlier, on the failures that happen before there is a
 * suite to have diagnostics about.
 *
 * It is not a `Diagnostic`, and deliberately: a `Diagnostic` names a `file`
 * and a `path` inside it, because it is about a test somebody wrote. None of
 * these are about a test. Giving them an empty `file` to reuse the type would
 * make every consumer of diagnostics handle a case that is not one.
 *
 * `code` is written for a program and may not be reworded; `message` is
 * written for a person and may be reworded in any release. The codes are bare
 * words, and `STARTUP_CODES` is the whole list — pinned by a test, which is
 * where a rename gets noticed.
 */
export class StartupError extends Error {
  readonly code: StartupCode

  constructor(code: StartupCode, message: string) {
    super(message)
    this.name = 'StartupError'
    this.code = code
  }
}

/**
 * Every reason the kernel refuses to start, in one place.
 *
 * Grouped by the step that raises it, which is also the order a caller meets
 * them in: there is no point reporting a plugin that will not load to somebody
 * who is standing in the wrong directory.
 */
export const STARTUP_CODES = [
  /* finding the project */
  'no-root',
  'ambiguous-root',
  'v1-project',

  /* reading the config */
  'no-config',
  'malformed-config',
  'unsupported-config-version',
  'circular-extends',
  'preset-not-found',
  'malformed-plugins',
  'missing-env-var',
  'unknown-environment',
  'environment-sets-reserved',

  /* loading the plugins */
  'plugin-not-found',
  'plugin-path-missing',
  'not-a-plugin',
  'incompatible-plugin',
  'duplicate-capability',
  'duplicate-service',
  'reserved-prefix'
] as const

export type StartupCode = (typeof STARTUP_CODES)[number]

/**
 * The document a `--json` caller gets instead of a result.
 *
 * `plugin-cli` already draws this line for a run: a malformed `--shard` stays
 * prose on stderr, because a caller that wrote it has a bug in itself rather
 * than a result to read, while anything true *about the project* goes to
 * stdout as a document. A speq.yaml from a later build is a fact about the
 * project. So it goes to stdout, and a script that pipes `speq run --json`
 * into a parser gets something parseable on the day the config is wrong
 * instead of an empty stream.
 *
 * `not-started` rather than `error` or `invalid`, both of which are taken and
 * would be ambiguous: `error` is a run status meaning the question was never
 * asked, and `invalid` carries `diagnostics`, which a caller would then look
 * for and find missing.
 */
export interface StartupFailure {
  status: 'not-started'
  error: { code: StartupCode; message: string }
}

export function startupFailure(err: StartupError): StartupFailure {
  return { status: 'not-started', error: { code: err.code, message: err.message } }
}
