export interface GlobalErrorCaptureOptions {
  /** Whether the application already reported this error value through `reportError()`. */
  isReported: (error: unknown) => boolean
  report: (message: string, error: unknown) => void
}

export const UNCAUGHT_ERROR_MESSAGE = 'Uncaught error'
export const UNHANDLED_REJECTION_MESSAGE = 'Unhandled promise rejection'

/**
 * Reports uncaught errors and unhandled promise rejections through `reportError()`.
 *
 * Reporting waits for a task so that the rest of the event dispatch runs first. An application
 * listener that reports the same error object, or an error that was reported and then rethrown,
 * produces one report.
 */
export function installGlobalErrorCapture(options: GlobalErrorCaptureOptions): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }
  const pending = new Set<ReturnType<typeof setTimeout>>()
  const reportLater = (message: string, error: unknown) => {
    const timer = setTimeout(() => {
      pending.delete(timer)
      if (!options.isReported(error)) {
        options.report(message, error)
      }
    }, 0)
    pending.add(timer)
  }
  const onError = (event: Event) => {
    // Resource load failures reach Window capture listeners as plain `error` events.
    if (!(event instanceof ErrorEvent)) {
      return
    }
    // Cross-origin scripts report a null error with the message "Script error."
    reportLater(UNCAUGHT_ERROR_MESSAGE, event.error ?? event.message)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    reportLater(UNHANDLED_REJECTION_MESSAGE, event.reason)
  }

  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection, true)
  return () => {
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection, true)
    for (const timer of pending) {
      clearTimeout(timer)
    }
    pending.clear()
  }
}

/** Tracks the error objects passed to `reportError()`. Primitive values cannot be tracked. */
export class ReportedErrors {
  private readonly errors = new WeakSet()

  add(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      this.errors.add(error)
    }
  }

  has(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.errors.has(error)
  }
}
