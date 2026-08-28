import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ArtifactRecord {
  test: string
  name: string
  contentType: string
  bytes: number
  /** Where it was written. Absent when the run has no artifact directory. */
  path?: string
  /** Retained only when nothing was written, so a library caller can read it. */
  body?: string | Uint8Array
}

/**
 * `ctx.attach` was on the published contract from day one, but the body went
 * nowhere: the event carried a byte count and the bytes themselves were
 * dropped. A screenshot plugin makes that immediately fatal, so the store is
 * the kernel keeping a promise it had already made.
 *
 * Note what did *not* change: `attach(name, body, contentType)` has the exact
 * same signature. Only the kernel's end of it grew, and `path` is an added
 * field on an event — a minor, by the rule the API package states.
 */
export class ArtifactStore {
  readonly #dir: string | undefined
  readonly #records: ArtifactRecord[] = []
  readonly #used = new Set<string>()

  constructor(baseDir: string | undefined, runId: string) {
    this.#dir = baseDir ? join(baseDir, runId, 'artifacts') : undefined
  }

  put(test: string, name: string, body: string | Uint8Array, contentType: string): ArtifactRecord {
    const bytes = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength

    if (!this.#dir) {
      const record: ArtifactRecord = { test, name, contentType, bytes, body }
      this.#records.push(record)
      return record
    }

    const folder = slug(test)
    const file = this.#unique(folder, slug(name))
    const dir = join(this.#dir, folder)
    const path = join(dir, file)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, typeof body === 'string' ? body : Buffer.from(body))

    const record: ArtifactRecord = { test, name, contentType, bytes, path }
    this.#records.push(record)
    return record
  }

  /** Everything attached so far, in the order it was attached. */
  all(): readonly ArtifactRecord[] {
    return this.#records
  }

  forTest(test: string): ArtifactRecord[] {
    return this.#records.filter((r) => r.test === test)
  }

  /** Two screenshots called `login` in one test are two files, not one. */
  #unique(folder: string, base: string): string {
    if (!this.#used.has(`${folder}/${base}`)) {
      this.#used.add(`${folder}/${base}`)
      return base
    }
    const dot = base.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${ext}`
      if (this.#used.has(`${folder}/${candidate}`)) continue
      this.#used.add(`${folder}/${candidate}`)
      return candidate
    }
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unnamed'
}
