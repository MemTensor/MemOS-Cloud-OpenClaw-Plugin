import type { Session } from '@deepseek-ai/dsh-session'

export class SessionWriteQueue {
  readonly #active = new Set<Promise<void>>()
  readonly #tails = new WeakMap<Session, Promise<void>>()
  readonly #budgets = new Map<Session, number>()

  get pending(): number { return this.#active.size }

  /** Sequential work adds within a session; independent sessions run in parallel. */
  timeoutBudget(session?: Session): number {
    if (session !== undefined) return Math.max(15_000, this.#budgets.get(session) ?? 0)
    let maximum = 15_000
    for (const budget of this.#budgets.values()) maximum = Math.max(maximum, budget)
    return maximum
  }

  enqueue(session: Session, job: () => Promise<void>, timeoutBudgetMs = 0): void {
    const previous = this.#tails.get(session) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(job)
    this.#tails.set(session, task)
    this.#active.add(task)
    this.#budgets.set(session, (this.#budgets.get(session) ?? 0) + timeoutBudgetMs)
    void task.finally(() => {
      this.#active.delete(task)
      const remaining = (this.#budgets.get(session) ?? 0) - timeoutBudgetMs
      if (remaining > 0) this.#budgets.set(session, remaining)
      else this.#budgets.delete(session)
      if (this.#tails.get(session) === task) this.#tails.delete(session)
    }).catch(() => {})
  }

  async drain(session?: Session): Promise<void> {
    if (session !== undefined) {
      let tail: Promise<void> | undefined
      while ((tail = this.#tails.get(session)) !== undefined) await tail.catch(() => {})
      return
    }
    while (this.#active.size > 0) await Promise.allSettled([...this.#active])
  }
}
