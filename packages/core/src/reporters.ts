import { join } from 'node:path'
import type { ReporterContext, ReporterDef, RunEvent } from '@speqkit/plugin-api'
import type { Registry } from './registry.js'
import { readRunLog } from './run-log.js'

export interface ReporterSession {
  /** Names actually started, in the order they were asked for. */
  readonly names: readonly string[]
  /** Drains every reporter's queue, calls `finalize`, and unsubscribes. */
  finalize(): Promise<void>
}

/**
 * Drives the reporters the run was asked for.
 *
 * `defineReporter` was on the contract from the first commit and nothing ever
 * called it: the console output went straight to `events.subscribe`, around
 * the mechanism rather than through it. An extension point nobody walks end to
 * end does not work — the gate proved that twice already — so the console
 * reporter is now an ordinary reporter and the default `--reporter` value, and
 * this is the code that runs it.
 */
export async function startReporters(
  registry: Registry,
  names: readonly string[],
  ctx: ReporterContext
): Promise<ReporterSession> {
  const runners = selectReporters(registry, names).map(
    ([name, def]) => new Runner(name, def, (n, err) => reportFailure(registry, n, err))
  )

  for (const runner of runners) {
    try {
      await runner.def.init?.(ctx)
    } catch (err) {
      runner.kill()
      reportFailure(registry, runner.name, err)
    }
  }

  const unsubscribe = registry.events.subscribe((event) => {
    for (const runner of runners) runner.push(event)
  })

  return {
    names: runners.map((r) => r.name),
    async finalize() {
      unsubscribe()
      for (const runner of runners) await runner.finalize()
    }
  }
}

/**
 * Renders a run that already happened by re-emitting its recorded events.
 *
 * Nothing here knows it is a replay: the events go onto the same bus a live
 * run uses, so a reporter cannot tell the difference and does not have to.
 */
export async function replayRun(
  registry: Registry,
  dir: string,
  names: readonly string[],
  outputDir?: string
): Promise<{ events: RunEvent[]; names: readonly string[] }> {
  const events = readRunLog(dir)
  const started = events.find((e) => e.type === 'run.started')
  const runId = started?.type === 'run.started' ? started.runId : dir

  const session = await startReporters(registry, names, { runId, outputDir, runDir: dir })
  for (const event of events) registry.events.emit(event)
  await session.finalize()
  return { events, names: session.names }
}

/**
 * Resolves names to definitions, failing before the run rather than during it.
 * A typo in a CI workflow should cost a second, not a full suite.
 */
export function selectReporters(
  registry: Registry,
  names: readonly string[]
): [string, ReporterDef][] {
  return names.map((name) => {
    const entry = registry.reporters.get(name)
    if (!entry) {
      const available = [...registry.reporters.keys()].sort()
      throw new Error(
        `unknown reporter '${name}'. ` +
          (available.length
            ? `Loaded reporters: ${available.join(', ')}`
            : `No plugin registered one — add '@speqkit/plugin-cli' or '@speqkit/plugin-junit'.`)
      )
    }
    return [name, entry.def]
  })
}

/** `reports/<runId>/`, matching where the artifact store writes. */
export function runDirFor(outputDir: string | undefined, runId: string): string | undefined {
  return outputDir ? join(outputDir, runId) : undefined
}

/**
 * One reporter's serial queue.
 *
 * `on` may return a promise, and the event bus is synchronous, so without a
 * queue a reporter that awaits anything would interleave its events. A
 * reporter that throws is dropped for the rest of the run instead of being
 * asked again on every subsequent event.
 */
class Runner {
  #queue: Promise<void> = Promise.resolve()
  #dead = false

  constructor(
    readonly name: string,
    readonly def: ReporterDef,
    private readonly onError: (name: string, err: unknown) => void
  ) {}

  kill(): void {
    this.#dead = true
  }

  push(event: RunEvent): void {
    if (this.#dead) return
    this.#queue = this.#queue
      .then(() => this.def.on(event))
      .catch((err: unknown) => {
        this.#dead = true
        this.onError(this.name, err)
      })
  }

  async finalize(): Promise<void> {
    await this.#queue
    if (this.#dead || !this.def.finalize) return
    try {
      await this.def.finalize()
    } catch (err) {
      this.onError(this.name, err)
    }
  }
}

function reportFailure(registry: Registry, name: string, err: unknown): void {
  registry.events.emit({
    type: 'diagnostic',
    level: 'error',
    message: `reporter '${name}' failed and was dropped: ${err instanceof Error ? err.message : String(err)}`,
    source: name
  })
}
