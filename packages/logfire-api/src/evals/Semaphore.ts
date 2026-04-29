/**
 * Tiny FIFO async semaphore. Used to bound concurrent case execution.
 */
export class Semaphore {
  private permits: number
  private waiters: (() => void)[] = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--
      return () => {
        this.release()
      }
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    return () => {
      this.release()
    }
  }

  tryAcquire(): (() => void) | null {
    if (this.permits <= 0) return null
    this.permits--
    return () => {
      this.release()
    }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) {
      next()
    } else {
      this.permits++
    }
  }
}
