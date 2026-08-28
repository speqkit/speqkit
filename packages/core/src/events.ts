import type { RunEvent, EventListener } from '@speqkit/plugin-api'

/** The one channel every surface — CLI, TUI, VS Code, reporters — listens on. */
export class EventBus {
  #listeners: EventListener[] = []

  subscribe(listener: EventListener): () => void {
    this.#listeners.push(listener)
    return () => {
      const i = this.#listeners.indexOf(listener)
      if (i >= 0) this.#listeners.splice(i, 1)
    }
  }

  emit(event: RunEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (err) {
        // A broken reporter must never take the run down with it.
        process.stderr.write(`speq: reporter threw on ${event.type}: ${String(err)}\n`)
      }
    }
  }
}
