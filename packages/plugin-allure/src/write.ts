import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AllureBundle } from './build.js'

export interface WriteOptions {
  /** The results directory. Created if it is not there. */
  dir: string
  /** Written into `environment.properties`, which Allure shows as a panel. */
  environment?: Record<string, string>
  /** Written into `executor.json`, which is what puts a build link in the header. */
  executor?: Record<string, unknown>
  /** Written into `categories.json`, Allure's rules for bucketing failures. */
  categories?: unknown[]
  /** Remove the results of a previous run first — see `clean`. */
  clean?: boolean
}

export interface WriteReport {
  dir: string
  results: number
  containers: number
  attachments: number
  /** Attachments named by the run that were not on disk to copy. */
  missing: string[]
}

/**
 * What Allure's own file names look like, and the only things `clean` removes.
 *
 * The results directory is one a user names in `speq.yaml`, and somebody will
 * eventually point it at a directory that holds something else. `rm -rf` on a
 * path out of a config file is not a thing this plugin is going to do, so the
 * sweep is by pattern: a file this plugin could have written, and nothing else.
 * A stray file in there survives, which is the correct failure mode.
 */
const OURS =
  /(-result\.json|-container\.json|-attachment(\.[A-Za-z0-9]+)?)$|^(environment\.properties|executor\.json|categories\.json)$/

export function writeBundle(bundle: AllureBundle, options: WriteOptions): WriteReport {
  const { dir } = options
  mkdirSync(dir, { recursive: true })

  if (options.clean) {
    for (const name of readdirSync(dir)) {
      if (OURS.test(name)) rmSync(join(dir, name), { force: true })
    }
  }

  for (const result of bundle.results) {
    writeFileSync(join(dir, `${result.uuid}-result.json`), `${JSON.stringify(result, null, 2)}\n`)
  }
  for (const container of bundle.containers) {
    writeFileSync(join(dir, `${container.uuid}-container.json`), `${JSON.stringify(container, null, 2)}\n`)
  }

  const missing: string[] = []
  let copied = 0
  for (const copy of bundle.copies) {
    try {
      copyFileSync(copy.from, join(dir, copy.to))
      copied++
    } catch {
      // A run whose report directory was cleaned between the run and the
      // report is the ordinary case here, and it is not worth failing a build
      // over: the report is written, the picture is not in it, and the count
      // says so out loud.
      missing.push(copy.from)
    }
  }

  const environment = { ...(bundle.runId ? { 'speq.runId': bundle.runId } : {}), ...(options.environment ?? {}) }
  if (Object.keys(environment).length > 0) {
    writeFileSync(join(dir, 'environment.properties'), properties(environment))
  }
  if (options.executor) {
    writeFileSync(join(dir, 'executor.json'), `${JSON.stringify(options.executor, null, 2)}\n`)
  }
  if (options.categories) {
    writeFileSync(join(dir, 'categories.json'), `${JSON.stringify(options.categories, null, 2)}\n`)
  }

  return {
    dir,
    results: bundle.results.length,
    containers: bundle.containers.length,
    attachments: copied,
    missing
  }
}

/**
 * A `.properties` file, escaped the way Java's own reader unescapes it.
 *
 * Allure parses this with `java.util.Properties`, where a bare `:` or `=` in a
 * key ends it and a newline in a value ends the line. A base URL with a port
 * in it — which is what anybody puts in here first — contains both.
 */
export function properties(values: Record<string, string>): string {
  const escapeKey = (value: string): string => value.replace(/([=:\\ ])/g, '\\$1')
  const escapeValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n')
  return `${Object.entries(values)
    .map(([key, value]) => `${escapeKey(key)}=${escapeValue(value)}`)
    .join('\n')}\n`
}
