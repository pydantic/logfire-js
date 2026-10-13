/**
 * An in-memory `LockManager` for unit tests. It grants exclusive locks per name in request order,
 * honors a request's signal only while the request waits, and can drop a held lock the way Safari
 * does when a page enters the back-forward cache.
 */
export class FakeLockManager {
  readonly requested: string[] = []
  private readonly holders = new Map<string, Holder>()
  private readonly waiters = new Map<string, Waiter[]>()

  async request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    this.requested.push(name)
    return new Promise<unknown>((resolve, reject) => {
      const signal = options.signal
      if (signal?.aborted === true) {
        reject(new DOMException('The request was aborted.', 'AbortError'))
        return
      }
      const waiter: Waiter = { callback, reject, resolve, signal }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const queue = this.waiters.get(name) ?? []
          const index = queue.indexOf(waiter)
          if (index >= 0) {
            queue.splice(index, 1)
            reject(new DOMException('The request was aborted.', 'AbortError'))
          }
        }
        signal.addEventListener('abort', waiter.onAbort)
      }
      const queue = this.waiters.get(name) ?? []
      queue.push(waiter)
      this.waiters.set(name, queue)
      this.grantNext(name)
    })
  }

  isHeld(name: string): boolean {
    return this.holders.has(name)
  }

  /** Release a held lock and reject its request, as Safari does on back-forward cache entry. */
  drop(name: string): void {
    const holder = this.holders.get(name)
    if (holder === undefined) {
      return
    }
    this.holders.delete(name)
    holder.reject(new DOMException('The lock was released.', 'AbortError'))
    this.grantNext(name)
  }

  private grantNext(name: string): void {
    if (this.holders.has(name)) {
      return
    }
    const queue = this.waiters.get(name) ?? []
    const waiter = queue.shift()
    if (waiter === undefined) {
      return
    }
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
    }
    const holder: Holder = { reject: waiter.reject }
    this.holders.set(name, holder)
    const finish = (): void => {
      if (this.holders.get(name) === holder) {
        this.holders.delete(name)
        this.grantNext(name)
      }
    }
    Promise.resolve()
      .then(() => waiter.callback({ mode: 'exclusive', name }))
      .then(
        (value: unknown) => {
          finish()
          waiter.resolve(value)
        },
        (error: unknown) => {
          finish()
          waiter.reject(error)
        }
      )
  }
}

interface Waiter {
  callback: (lock: Lock | null) => unknown
  onAbort?: () => void
  reject: (error: unknown) => void
  resolve: (value: unknown) => void
  signal: AbortSignal | undefined
}

interface Holder {
  reject: (error: unknown) => void
}
