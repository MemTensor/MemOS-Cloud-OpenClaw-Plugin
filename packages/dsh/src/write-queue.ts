import type { Session } from '@deepseek-ai/dsh-session'

export class SessionWriteQueue {
  readonly #active = new Set<Promise<void>>()
  readonly #tails = new WeakMap<Session, Promise<void>>()

  enqueue(session: Session, job: () => Promise<void>): void {
    const previous = this.#tails.get(session) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(job)
    this.#tails.set(session, task)
    this.#active.add(task)
    void task.finally(() => {
      this.#active.delete(task)
      if (this.#tails.get(session) === task) this.#tails.delete(session)
    }).catch(() => {})
  }

  async drain(): Promise<void> {
    while (this.#active.size > 0) await Promise.allSettled([...this.#active])
  }
}
