import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { STARTUP_CODES, StartupError, bootstrap, discoverRoot } from 'speqkit'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * What a caller finds out when speq refuses before it starts.
 *
 * `bootstrap()` is four steps — find the project, read the config, load the
 * plugins, hand over control — and each of the first three can refuse. Every
 * refusal used to be a bare `Error` printed as prose, so telling "there is no
 * speq.yaml" from "this speq.yaml is from a later build" from "that plugin is
 * declared but not installed" meant matching substrings of a sentence written
 * for a person. M8 removed that obligation from validation by putting a `code`
 * on every diagnostic; these are the failures that happen before there is a
 * suite to have diagnostics about.
 *
 * Driven through the real binary, with **stdout and stderr kept apart**. That
 * separation is the subject rather than a detail of the harness: merging them
 * is how the earlier reading of this behaviour went wrong.
 */

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** Under examples/basic, so `yaml` and `cli` resolve the way they would anywhere. */
function project(config: string): string {
  const dir = mkdtempSync(join(repo, 'examples/basic', 'speq-startup-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'suites'))
  writeFileSync(join(dir, 'speq.yaml'), config)
  return dir
}

function speq(dir: string, argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'node',
    ['--import', 'tsx', join(repo, 'packages/core/src/bin.ts'), ...argv],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
  )
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

const GOOD = 'version: 1\nplugins:\n  - yaml\n  - cli\n'

describe('a refusal to start', () => {
  it('says why on stderr, and exits 2', () => {
    const { code, stdout, stderr } = speq(project('version: 2\nplugins: []\n'), ['run'])

    expect(code).toBe(2)
    expect(stderr).toContain('declares version 2')
    // Prose belongs on stderr, whole. A caller redirecting stdout to a file
    // gets an empty file rather than half a sentence in it.
    expect(stdout).toBe('')
  })

  /**
   * `plugin-cli` already draws this line inside a run: a malformed `--shard`
   * stays prose on stderr, because a caller that wrote it has a bug in itself
   * rather than a result to read, while anything true *about the project* is a
   * document on stdout. A speq.yaml from a later build is a fact about the
   * project — so `speq run --json` used to answer it with an empty stdout, and
   * the script parsing that fell over somewhere else entirely.
   */
  it('is a document on stdout when the caller asked for --json', () => {
    const { code, stdout, stderr } = speq(project('version: 2\nplugins: []\n'), ['run', '--json'])

    expect(code).toBe(2)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      status: 'not-started',
      error: {
        code: 'unsupported-config-version',
        message: 'speq.yaml declares version 2; this build understands version 1'
      }
    })
  })

  /**
   * `not-started` rather than `error` or `invalid`, both of which are taken and
   * would be ambiguous: `error` is a run status meaning the question was never
   * asked, and `invalid` carries `diagnostics`, which a caller would look for
   * and find missing.
   */
  it('uses a status no run outcome can produce', () => {
    const { stdout } = speq(project('version: 2\nplugins: []\n'), ['run', '--json'])

    expect(JSON.parse(stdout).status).toBe('not-started')
    expect(['passed', 'failed', 'error', 'skipped', 'invalid', 'no-tests'])
      .not.toContain(JSON.parse(stdout).status)
  })

  /**
   * The whole point, in one assertion: four different things going wrong are
   * four different codes, and none of them has to be told apart by its
   * sentence. The messages here are deliberately not asserted on — they are
   * written for a person and may be reworded in any release.
   */
  it('tells four failures apart without reading a word of the message', () => {
    const codeOf = (dir: string, argv: string[] = ['run', '--json']): string =>
      JSON.parse(speq(dir, argv).stdout).error.code

    // Pointed at a directory that is not a project, rather than left to walk
    // up and find one: root discovery walks upwards, so an empty directory
    // under `examples/basic` is not "no project", it is `examples/basic` seen
    // from one level down.
    const nowhere = mkdtempSync(join(tmpdir(), 'speq-startup-'))
    scratch.push(nowhere)
    const here = project(GOOD)

    expect(codeOf(here, ['run', '--json', '--speq-root', nowhere])).toBe('no-config')
    expect(codeOf(project('version: 2\nplugins: []\n'))).toBe('unsupported-config-version')
    expect(codeOf(project('version: 1\nplugins:\n  - nonesuch\n'))).toBe('plugin-not-found')
    expect(codeOf(project('version: 1\nplugins: [\n'))).toBe('malformed-config')
  })

  /**
   * The walk itself, in process, because it cannot be reached through the
   * binary: standing outside the repository is also standing outside the
   * `tsx` this harness loads the kernel with.
   */
  it('says it could not find a root, which is not the same as finding a bad one', () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'speq-startup-'))
    scratch.push(nowhere)

    try {
      discoverRoot(undefined, nowhere)
      expect.unreachable('a directory with no project above it has no root')
    } catch (err) {
      expect(err).toBeInstanceOf(StartupError)
      expect((err as StartupError).code).toBe('no-root')
    }
  })

  /** The failure happens in the bootstrap, so it precedes whichever command asked. */
  it('answers the same way whatever command was being run', () => {
    const dir = project('version: 2\nplugins: []\n')

    for (const command of ['run', 'list', 'validate', 'docs', 'capabilities']) {
      const { code, stdout } = speq(dir, [command, '--json'])
      expect(code, command).toBe(2)
      expect(JSON.parse(stdout).error.code, command).toBe('unsupported-config-version')
    }
  })

  /** An embedder catches the same thing, without a subprocess or a stream. */
  it('carries the code to a caller that embedded the kernel', async () => {
    const dir = project('version: 2\nplugins: []\n')

    await expect(bootstrap({ root: dir })).rejects.toBeInstanceOf(StartupError)
    await bootstrap({ root: dir }).catch((err: StartupError) => {
      expect(err.code).toBe('unsupported-config-version')
    })
  })

  /**
   * The vocabulary in one place, the way `kernel.test.ts` pins the diagnostic
   * codes. A code is written for a program and may not be reworded, so a
   * rename has to fail here rather than in somebody's CI script.
   */
  it('has one list of codes, and no duplicates in it', () => {
    expect([...STARTUP_CODES]).toEqual([
      'no-root',
      'ambiguous-root',
      'v1-project',
      'no-config',
      'malformed-config',
      'unsupported-config-version',
      'circular-extends',
      'preset-not-found',
      'malformed-plugins',
      'missing-env-var',
      'unknown-environment',
      'environment-sets-reserved',
      'plugin-not-found',
      'plugin-path-missing',
      'not-a-plugin',
      'incompatible-plugin',
      'duplicate-capability',
      'duplicate-service',
      'reserved-prefix'
    ])
    expect(new Set(STARTUP_CODES).size).toBe(STARTUP_CODES.length)
  })

  /** A project that starts is untouched by any of this. */
  it('leaves a good project alone', () => {
    const { code, stdout, stderr } = speq(project(GOOD), ['list', '--json'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout).status).not.toBe('not-started')
  })
})
