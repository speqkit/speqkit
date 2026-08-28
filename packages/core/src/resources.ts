import type { ResourceDef, ResourceScope, ResourceContext } from '@speqkit/plugin-api'

interface Entry {
  owner: string
  def: ResourceDef<unknown>
}

/**
 * Resources are acquired lazily and torn down in reverse order of acquisition
 * when their scope closes. A browser lives for the run; a transaction lives
 * for one test and rolls back after it. Data isolation under parallel
 * execution falls out of this, rather than being bolted on later.
 */
export class ResourceManager {
  #defs = new Map<string, Entry>()
  #frames: { scope: ResourceScope; live: Map<string, unknown>; order: string[] }[] = []

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

  open(scope: ResourceScope): void {
    this.#frames.push({ scope, live: new Map(), order: [] })
  }

  async close(scope: ResourceScope, configFor: (plugin: string) => Record<string, unknown>): Promise<void> {
    const frame = this.#frames.pop()
    if (!frame) return
    if (frame.scope !== scope) {
      throw new Error(`internal: closing '${scope}' but innermost frame is '${frame.scope}'`)
    }
    for (const name of [...frame.order].reverse()) {
      const entry = this.#defs.get(name)
      const value = frame.live.get(name)
      if (!entry?.def.teardown) continue
      try {
        await entry.def.teardown(value, this.#context(entry.owner, configFor))
      } catch (err) {
        process.stderr.write(`speq: teardown of resource '${name}' failed: ${String(err)}\n`)
      }
    }
  }

  async acquire(
    name: string,
    configFor: (plugin: string) => Record<string, unknown>
  ): Promise<unknown> {
    const entry = this.#defs.get(name)
    if (!entry) {
      const known = [...this.#defs.keys()].sort().join(', ') || '(none)'
      throw new Error(`unknown resource '${name}'; loaded plugins provide: ${known}`)
    }

    // Innermost frame matching the resource's declared scope owns the value.
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      const frame = this.#frames[i]!
      if (frame.live.has(name)) return frame.live.get(name)
    }

    const target = [...this.#frames].reverse().find((f) => f.scope === entry.def.scope)
    if (!target) {
      throw new Error(
        `resource '${name}' has scope '${entry.def.scope}', which is not open here`
      )
    }

    const value = await entry.def.setup(this.#context(entry.owner, configFor))
    target.live.set(name, value)
    target.order.push(name)
    return value
  }

  #context(owner: string, configFor: (plugin: string) => Record<string, unknown>): ResourceContext {
    return {
      resource: (n) => this.acquire(n, configFor) as Promise<never>,
      config: () => configFor(owner) as never
    }
  }
}
