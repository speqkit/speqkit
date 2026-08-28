import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEvent } from '@speq/plugin-api'

const FILE = 'events.jsonl'

/**
 * Every event of a run, one JSON object per line.
 *
 * This exists so `speq report` can render a run it did not execute — and by
 * doing so it keeps the central claim honest. If the event stream is really
 * the contract that reporters, the TUI and the VS Code panel all consume, then
 * replaying it must produce the same report as watching it live. A run log is
 * how that stops being a claim and becomes something a test can check.
 *
 * Written line by line rather than at the end: a run that crashes is exactly
 * the run whose record is worth having.
 */
export class RunLog {
  readonly dir: string | undefined
  #fd: number | undefined

  constructor(baseDir: string | undefined, runId: string) {
    this.dir = baseDir ? join(baseDir, runId) : undefined
  }

  write(event: RunEvent): void {
    if (!this.dir) return
    if (this.#fd === undefined) {
      mkdirSync(this.dir, { recursive: true })
      this.#fd = openSync(join(this.dir, FILE), 'a')
    }
    writeSync(this.#fd, `${JSON.stringify(event)}\n`)
  }

  close(): void {
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
  }
}

export interface RecordedRun {
  runId: string
  dir: string
  at: number
}

/** Reads a run log back. Malformed lines are skipped, not fatal — a crashed
 *  run can leave a half-written last line, and that is the run worth reading. */
export function readRunLog(dir: string): RunEvent[] {
  const file = join(dir, FILE)
  if (!existsSync(file)) {
    throw new Error(`no ${FILE} in ${dir}; that directory is not a recorded run`)
  }
  const events: RunEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as RunEvent)
    } catch {
      continue
    }
  }
  return events
}

/** Every recorded run under `reports/`, newest first. */
export function listRuns(baseDir: string): RecordedRun[] {
  let names: string[]
  try {
    names = readdirSync(baseDir)
  } catch {
    return []
  }

  const runs: RecordedRun[] = []
  for (const name of names) {
    const dir = join(baseDir, name)
    const file = join(dir, FILE)
    if (!existsSync(file)) continue
    runs.push({ runId: name, dir, at: startedAt(file) })
  }
  return runs.sort((a, b) => b.at - a.at)
}

/**
 * The run's own timestamp, taken from its first line rather than from the
 * file's mtime: a reports directory downloaded from CI arrives with whatever
 * mtimes the unpacker felt like, and the ordering has to survive that.
 */
function startedAt(file: string): number {
  try {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0] ?? ''
    const event = JSON.parse(first) as RunEvent
    return event.type === 'run.started' ? event.at : 0
  } catch {
    return 0
  }
}
