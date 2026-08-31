import type { ResourceDef, ResourceScope, ResourceContext } from '@speqkit/plugin-api'

interface Entry {
  owner: string
  def: ResourceDef<unknown>
}

type ConfigFor = (plugin: string) => Record<string, unknown>

/**
 * One scope, holding whatever was acquired inside it.
 *
 * Frames form a tree — one `run` frame, a `suite` frame per suite, a `test`
 * frame per test — and a frame is handed to whoever runs inside it. That is
 * the whole of what parallelism costs here. A stack would have been enough
 * for a sequential run and was what this file held for a year: `open` pushed,
 * `close` popped, and two suites running at once meant one suite's
 * `close('test')` popped the frame the other had just opened.
 *
 * With a tree there is no innermost frame to get wrong. A lookup walks its
 * own parents and reaches nothing that belongs to a sibling, so data
 * isolation under parallel execution falls out of the model rather than
 * being bolted on.
 */
export class ResourceFrame {
  readonly scope: ResourceScope

  readonly #manager: ResourceManager
  readonly #parent: ResourceFrame | undefined
  /**
   * The promise, not the value.
   *
   * Caching the resolved value left a window the length of `setup` in which
   * the cache is empty and a second caller is already asking: two suites
   * acquiring one resource at once both found nothing, both ran `setup`, and
   * the second overwrote the first — which was then never torn down while the
   * second was torn down twice. Caching the promise closes the window, because
   * it is in the map before anything is awaited.
   */
  readonly #live = new Map<string, Promise<unknown>>()
  readonly #order: string[] = []
  #closed = false

  /** @internal — frames come from `ResourceManager.open` or `frame.open`. */
  constructor(manager: ResourceManager, scope: ResourceScope, parent: ResourceFrame | undefined) {
    this.#manager = manager
    this.scope = scope
    this.#parent = parent
  }

  /** A frame nested inside this one: a suite inside the run, a test inside a suite. */
  open(scope: ResourceScope): ResourceFrame {
    return new ResourceFrame(this.#manager, scope, this)
  }

  acquire(name: string, configFor: ConfigFor): Promise<unknown> {
    try {
      return this.#acquire(name, configFor)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /**
   * Deliberately not `async`: everything up to and including the write to
   * `#live` has to happen in one synchronous run, or the window this class
   * exists to close is open again.
   */
  #acquire(name: string, configFor: ConfigFor): Promise<unknown> {
    const entry = this.#manager.definition(name)

    // Whoever holds it already, holds it: this frame first, then outwards.
    for (let frame: ResourceFrame | undefined = this; frame; frame = frame.#parent) {
      const live = frame.#live.get(name)
      if (live) return live
    }

    let target: ResourceFrame | undefined = this
    while (target && target.scope !== entry.def.scope) target = target.#parent
    if (!target) {
      throw new Error(`resource '${name}' has scope '${entry.def.scope}', which is not open here`)
    }
    if (target.#closed) {
      throw new Error(
        `resource '${name}' was asked for after its '${target.scope}' scope closed`
      )
    }

    const owner = target
    const pending = (async () => entry.def.setup(owner.#context(entry.owner, configFor)))()
    owner.#live.set(name, pending)
    owner.#order.push(name)
    return pending
  }

  /**
   * Tear down what this frame acquired, in reverse order, and close it.
   *
   * Awaiting the cached promise is what makes a setup still in flight safe:
   * it finishes, and then its value is taken down. Teardown may still acquire
   * — a fixture releasing itself through the connection that made it — which
   * is why the frame keeps answering for what it already holds while it
   * closes, and refuses only to set anything new up.
   */
  async close(configFor: ConfigFor): Promise<void> {
    if (this.#closed) return
    this.#closed = true

    for (const name of [...this.#order].reverse()) {
      const entry = this.#manager.definition(name)
      let value: unknown
      try {
        value = await this.#live.get(name)
      } catch {
        // Setup never produced a value, so there is nothing to take down.
        // Whoever asked for it already saw the failure.
        continue
      }
      if (!entry.def.teardown) continue
      try {
        await entry.def.teardown(value, this.#context(entry.owner, configFor))
      } catch (err) {
        process.stderr.write(`speq: teardown of resource '${name}' failed: ${String(err)}\n`)
      }
    }

    this.#live.clear()
    this.#order.length = 0
  }

  #context(owner: string, configFor: ConfigFor): ResourceContext {
    return {
      resource: (n) => this.acquire(n, configFor) as Promise<never>,
      config: () => configFor(owner) as never
    }
  }
}

/**
 * Resources are acquired lazily and torn down in reverse order of acquisition
 * when their scope closes. A browser lives for the run; a transaction lives
 * for one test and rolls back after it.
 *
 * The manager holds only the definitions. Where a value lives is a
 * `ResourceFrame`, and the tree of those is what keeps two suites running at
 * once from sharing anything they did not declare as shared.
 */
export class ResourceManager {
  #defs = new Map<string, Entry>()

  define(name: string, owner: string, def: ResourceDef<unknown>): void {
    const existing = this.#defs.get(name)
    if (existing) {
      throw new Error(
        `resource '${name}' is already provided by plugin '${existing.owner}'; ` +
          `plugin '${owner}' cannot redefine it`
      )
    }
    this.#defs.set(name, { owner, def })
  }

  has(name: string): boolean {
    return this.#defs.has(name)
  }

  /** The outermost frame. Everything else is opened inside one of these. */
  open(scope: ResourceScope): ResourceFrame {
    return new ResourceFrame(this, scope, undefined)
  }

  /** @internal — what a frame needs to set a resource up or take it down. */
  definition(name: string): Entry {
    const entry = this.#defs.get(name)
    if (!entry) {
      const known = [...this.#defs.keys()].sort().join(', ') || '(none)'
      throw new Error(`unknown resource '${name}'; loaded plugins provide: ${known}`)
    }
    return entry
  }
}
